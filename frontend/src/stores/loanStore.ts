import { create } from 'zustand'
import type { Loan, Storage } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { storageStore } from './storageStore'
import { activeLoansBySpecimen, isOpenLoan } from '@/utils/custody'
import { encodeSlot } from '@/utils/codec'

/** 事务作用域表：事务体内统一用它，保证读写都挂在同一事务上 */
export interface LoanTxTables {
  storages: typeof db.storages
  loans: typeof db.loans
  specimens: typeof db.specimens
}

/** 借还记录与柜位记录必须同生共死，统一在跨表事务里改写 */
async function runLoanTransaction<T>(work: (tx: LoanTxTables) => Promise<T>): Promise<T> {
  try {
    const result = await db.transaction('rw', db.storages, db.loans, db.specimens, async () => {
      // Dexie 在事务体内通过表名取得的就是当前事务作用域表
      const tx: LoanTxTables = { storages: db.storages, loans: db.loans, specimens: db.specimens }
      return work(tx)
    })
    // 提交成功：两份内存镜像都以数据库为准
    await storageStore.getState().hydrate()
    await loanStore.getState().hydrate()
    return result
  } catch (error) {
    // 写入失败：Dexie 已整体回滚（原柜位、借出状态、待归还清单都保持事务前状态），
    // 内存也必须重新对齐，重试时不会留下半条记录或产生重复记录
    await storageStore.getState().hydrate()
    await loanStore.getState().hydrate()
    throw error
  }
}

/** 借出登记信息 */
export interface LendInput {
  borrower: string
  organization: string
  loanDate: string
  dueDate: string
  handler: string
  note: string
}

/** 归还批处理中一份标本的去向 */
export interface ReturnOutcome {
  specimenId: string
  loanId: string
  /** 借出时记录的原柜位文本 */
  originSlot: string
  /** true：原柜位空着，已放回（借还记录结清）；false：原柜位被占，进入待归位区 */
  restored: boolean
}

export interface ReturnResult {
  /** 已放回原柜位的标本 */
  restored: ReturnOutcome[]
  /** 进入（或仍留在）待归位区的标本 */
  pending: ReturnOutcome[]
}

export interface LoanState {
  rows: Loan[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 整批借出：登记借用人/期限/原柜位快照并释放柜位 */
  lendMany: (specimenIds: string[], input: LendInput) => Promise<Loan[]>
  /** 归还登记：原柜位空着放回，被占用则进待归位区（不挤出现有标本） */
  returnMany: (specimenIds: string[], handler?: string) => Promise<ReturnResult>
  /** 对待归位区标本重试归位：原柜位空了就放回，否则继续等待 */
  retryRestore: (specimenIds: string[]) => Promise<ReturnResult>
  /**
   * 跨表入柜事务（柜位图拖拽/点击统一入口）：
   * - 柜位已被占用 → 回滚并报错，不覆盖现有标本
   * - 标本外借未还 → 回滚并报错，外借期间不能入柜
   * - 标本处于待归位 → 入柜成功后借还记录结清为「已归还」，原柜位信息保留在记录中
   */
  placeToStorage: (storage: Storage) => Promise<void>
}

function slotKey(storage: { cabinet: string; drawer: number; box: number; slot: number }): string {
  return encodeSlot(storage.cabinet, storage.drawer, storage.box, storage.slot)
}

/** 依据当年已有借出单分配下一个流水号 */
function nextLoanCodes(existing: Loan[], year: string, count: number): string[] {
  const serials = existing
    .map((loan) => /^LOAN-(\d{4})-(\d+)$/.exec(loan.code))
    .filter((match): match is RegExpExecArray => !!match && match[1] === year)
    .map((match) => Number(match[2]))
  let next = serials.length > 0 ? Math.max(...serials) + 1 : 1
  const codes: string[] = []
  for (let i = 0; i < count; i += 1) {
    codes.push(`LOAN-${year}-${String(next).padStart(4, '0')}`)
    next += 1
  }
  return codes
}

export const loanStore = create<LoanState>((set) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Loan>(db.loans)
    rows.sort((a, b) => (b.loanDate + b.code).localeCompare(a.loanDate + a.code))
    set({ rows, loaded: true })
  },

  lendMany: async (specimenIds, input) => {
    const ids = Array.from(new Set(specimenIds))
    if (ids.length === 0) throw new Error('请先勾选要外借的标本')
    if (!input.borrower.trim()) throw new Error('请填写借用人')
    if (!input.loanDate) throw new Error('请选择借出日期')
    if (!input.dueDate) throw new Error('请选择归还期限')
    if (input.dueDate < input.loanDate) throw new Error('归还期限不能早于借出日期')

    return runLoanTransaction(async (tx) => {
      const [specimens, allLoans, allStorages] = await Promise.all([
        tx.specimens.toArray(),
        tx.loans.toArray(),
        tx.storages.toArray()
      ])
      const codeOf = (specimenId: string): string =>
        specimens.find((item) => item.id === specimenId)?.code ?? specimenId
      const active = activeLoansBySpecimen(allLoans)

      const storagesOf = new Map<string, Storage[]>()
      allStorages.forEach((storage) => {
        const list = storagesOf.get(storage.specimenId) ?? []
        list.push(storage)
        storagesOf.set(storage.specimenId, list)
      })

      // 先整单校验：任何一份不合格，整批不出借（事务随后回滚，柜位一条都不释放）
      for (const specimenId of ids) {
        const current = active.get(specimenId)
        if (current) {
          throw new Error(
            `标本 ${codeOf(specimenId)} ${current.status === '待归位' ? '尚在待归位区' : '正在外借'}，不能重复借出`
          )
        }
        const placed = storagesOf.get(specimenId) ?? []
        if (placed.length === 0) {
          throw new Error(`标本 ${codeOf(specimenId)} 尚未入柜，没有原柜位可登记，请先入柜再借出`)
        }
      }

      const year = input.loanDate.slice(0, 4)
      const codes = nextLoanCodes(allLoans, year, ids.length)
      const created: Loan[] = []
      const storageIdsToDelete: string[] = []

      ids.forEach((specimenId, index) => {
        const originStorage = (storagesOf.get(specimenId) as Storage[])[0]
        // 确定性 ID：同一份标本同一天再次提交会撞上同一条，而不是新增第二条
        let loanId = `loan_${specimenId}_${input.loanDate.replace(/-/g, '')}`
        if (allLoans.some((loan) => loan.id === loanId) || created.some((loan) => loan.id === loanId)) {
          loanId = `${loanId}_${index + 1}`
        }
        created.push({
          id: loanId,
          code: codes[index],
          specimenId,
          borrower: input.borrower.trim(),
          organization: input.organization.trim(),
          loanDate: input.loanDate,
          dueDate: input.dueDate,
          returnedDate: '',
          status: '外借',
          origin: {
            storageId: originStorage.id,
            method: originStorage.method,
            cabinet: originStorage.cabinet,
            drawer: originStorage.drawer,
            box: originStorage.box,
            slot: originStorage.slot
          },
          handler: input.handler.trim(),
          note: input.note.trim()
        })
        ;(storagesOf.get(specimenId) as Storage[]).forEach((storage) => storageIdsToDelete.push(storage.id))
      })

      // 先登记借还记录，再释放柜位；任一步失败整笔事务回滚
      await tx.loans.bulkPut(created)
      await tx.storages.bulkDelete(storageIdsToDelete)
      return created
    })
  },

  returnMany: async (specimenIds, handler = '') => {
    const ids = Array.from(new Set(specimenIds))
    if (ids.length === 0) throw new Error('请先选择要归还的标本')
    const today = new Date().toISOString().slice(0, 10)

    return runLoanTransaction(async (tx) => {
      const [allLoans, allStorages] = await Promise.all([tx.loans.toArray(), tx.storages.toArray()])
      const occupiedSlots = new Set(allStorages.map(slotKey))

      const updatedLoans: Loan[] = []
      const restoredStorages: Storage[] = []
      const restored: ReturnOutcome[] = []
      const pending: ReturnOutcome[] = []

      for (const specimenId of ids) {
        // 只处理「外借」中的记录；待归位标本用 retryRestore，已归还记录不重复处理（重试不多记录）
        const loan = allLoans.find((item) => item.specimenId === specimenId && item.status === '外借')
        if (!loan) continue

        const originKey = slotKey(loan.origin)
        const outcome: ReturnOutcome = { specimenId, loanId: loan.id, originSlot: originKey, restored: false }

        if (occupiedSlots.has(originKey)) {
          // 原柜位被新标本占用：不挤掉现有标本，保留原柜位信息进入待归位区
          updatedLoans.push({ ...loan, status: '待归位', returnedDate: today })
          pending.push(outcome)
        } else {
          // 原柜位空着：按借出时的快照与原记录 ID 重建柜位记录，重试也只会得到同一条
          const restoredStorage: Storage = {
            id: loan.origin.storageId,
            specimenId,
            method: loan.origin.method,
            cabinet: loan.origin.cabinet,
            drawer: loan.origin.drawer,
            box: loan.origin.box,
            slot: loan.origin.slot,
            storedDate: today,
            handler: handler.trim()
          }
          occupiedSlots.add(originKey)
          restoredStorages.push(restoredStorage)
          updatedLoans.push({ ...loan, status: '已归还', returnedDate: today })
          restored.push({ ...outcome, restored: true })
        }
      }

      if (restoredStorages.length > 0) await tx.storages.bulkPut(restoredStorages)
      if (updatedLoans.length > 0) await tx.loans.bulkPut(updatedLoans)
      return { restored, pending }
    })
  },

  retryRestore: async (specimenIds) => {
    const ids = Array.from(new Set(specimenIds))
    if (ids.length === 0) throw new Error('请先选择待归位标本')

    return runLoanTransaction(async (tx) => {
      const [allLoans, allStorages] = await Promise.all([tx.loans.toArray(), tx.storages.toArray()])
      const occupiedSlots = new Set(allStorages.map(slotKey))

      const updatedLoans: Loan[] = []
      const restoredStorages: Storage[] = []
      const staleStorageIds: string[] = []
      const restored: ReturnOutcome[] = []
      const pending: ReturnOutcome[] = []

      for (const specimenId of ids) {
        const loan = allLoans.find((item) => item.specimenId === specimenId && item.status === '待归位')
        if (!loan) continue
        const originKey = slotKey(loan.origin)
        const outcome: ReturnOutcome = { specimenId, loanId: loan.id, originSlot: originKey, restored: false }

        if (occupiedSlots.has(originKey)) {
          // 原柜位仍被占用：继续等待，不改写记录，重试不会产生重复行
          pending.push(outcome)
          continue
        }

        // 待归位期间可能已被手工放到其他柜位（一条非原柜位记录），归位时清掉它，保证一标本一柜位
        allStorages
          .filter((item) => item.specimenId === specimenId && item.id !== loan.origin.storageId)
          .forEach((item) => {
            staleStorageIds.push(item.id)
            occupiedSlots.delete(slotKey(item))
          })

        occupiedSlots.add(originKey)
        restoredStorages.push({
          id: loan.origin.storageId,
          specimenId,
          method: loan.origin.method,
          cabinet: loan.origin.cabinet,
          drawer: loan.origin.drawer,
          box: loan.origin.box,
          slot: loan.origin.slot,
          storedDate: new Date().toISOString().slice(0, 10),
          handler: loan.handler
        })
        // 归还日期沿用最初归还登记日，归位动作只结清状态
        updatedLoans.push({ ...loan, status: '已归还' })
        restored.push({ ...outcome, restored: true })
      }

      if (staleStorageIds.length > 0) await tx.storages.bulkDelete(staleStorageIds)
      if (restoredStorages.length > 0) await tx.storages.bulkPut(restoredStorages)
      if (updatedLoans.length > 0) await tx.loans.bulkPut(updatedLoans)
      return { restored, pending }
    })
  },

  placeToStorage: async (storage) => {
    await runLoanTransaction(async (tx) => {
      const [allStorages, allLoans] = await Promise.all([tx.storages.toArray(), tx.loans.toArray()])
      const targetKey = slotKey(storage)
      const conflict = allStorages.find((item) => item.id !== storage.id && slotKey(item) === targetKey)
      if (conflict) {
        throw new Error(`柜位 ${targetKey} 已被其他标本占用，请换一个插位或先出柜`)
      }
      const open = allLoans.find((item) => item.specimenId === storage.specimenId && isOpenLoan(item))
      if (open?.status === '外借') {
        throw new Error(`该标本正在外借（借用人 ${open.borrower}，应还 ${open.dueDate || '—'}），归还前不能入柜`)
      }
      await tx.storages.put(storage)
      // 待归位标本手工入柜即完成归位：借还记录结清，原柜位快照随记录保留可追溯
      if (open?.status === '待归位') {
        await tx.loans.put({ ...open, status: '已归还' })
      }
    })
  }
}))
