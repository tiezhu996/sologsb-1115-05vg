import { create } from 'zustand'
import type { Loan, Specimen, Storage, StorageMethod } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import { storageStore } from './storageStore'
import { encodeSlot } from '@/utils/codec'
import { uid } from '@/utils/id'

export interface CheckoutInput {
  specimenIds: string[]
  borrower: string
  loanDate: string
  dueDate: string
  note?: string
}

export interface CheckoutResult {
  loaned: Loan[]
}

export interface ReturnResult {
  restored: Loan[]
  pending: Loan[]
}

export interface ReshelveInput {
  loanId: string
  cabinet: string
  drawer: number
  box: number
  slot: number
  method: StorageMethod
  handler: string
}

export interface LoanState {
  rows: Loan[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 批量确认外借：登记借用人/期限/原柜位并释放柜位 */
  checkoutMany: (input: CheckoutInput) => Promise<CheckoutResult>
  /** 批量归还：原柜位空着就放回（在库），已被占用则进入待归位，不挤掉现有标本 */
  returnMany: (specimenIds: string[], returnedDate: string) => Promise<ReturnResult>
  /** 待归位标本手工归位到指定空插位 */
  reshelvePending: (input: ReshelveInput) => Promise<Loan>
  remove: (id: string) => Promise<void>
}

/** 写入失败后以数据库为准重新水合，恢复原柜位/借出状态/待归还清单的内存镜像 */
async function rehydrateAfterFailure(): Promise<void> {
  await Promise.all([storageStore.getState().hydrate(), loanStore.getState().hydrate()])
}

/** 把原柜位快照还原成 Storage 记录（沿用外借前的记录 id，不新增柜位记录） */
function storageFromOrigin(loan: Loan): Storage {
  const origin = loan.origin
  if (!origin) throw new Error('缺少原柜位快照')
  return {
    id: origin.storageId,
    specimenId: loan.specimenId,
    method: origin.method,
    cabinet: origin.cabinet,
    drawer: origin.drawer,
    box: origin.box,
    slot: origin.slot,
    storedDate: origin.storedDate,
    handler: origin.handler
  }
}

export const loanStore = create<LoanState>((set) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Loan>(db.loans)
    rows.sort((a, b) => (b.loanDate + b.id).localeCompare(a.loanDate + a.id))
    set({ rows, loaded: true })
  },

  checkoutMany: async ({ specimenIds, borrower, loanDate, dueDate, note = '' }) => {
    const ids = Array.from(new Set(specimenIds))
    if (ids.length === 0) throw new Error('请选择需要外借的标本')
    if (!borrower.trim()) throw new Error('请填写借用人')
    if (!loanDate || !dueDate) throw new Error('请填写借出日期与归还期限')
    if (dueDate < loanDate) throw new Error('归还期限不能早于借出日期')

    try {
      const result = await db.transaction('rw', [db.specimens, db.storages, db.loans], async () => {
        const specimens = await db.specimens.where('id').anyOf(ids).toArray()
        if (specimens.length !== ids.length) throw new Error('部分标本不存在，请刷新后重试')

        // 外借期间的标本既不能再次外借，待归位标本需先完成归位
        const active = await db.loans.where('phase').anyOf(['借出', '归还待归位']).toArray()
        const blocked = active.filter((loan) => ids.includes(loan.specimenId))
        if (blocked.length > 0) {
          throw new Error(
            blocked.some((loan) => loan.phase === '归还待归位')
              ? '选中的标本中有的还在待归位区，请先归位再外借'
              : '选中的标本中有的已经外借，请勿重复登记'
          )
        }

        const storagesOf = await db.storages.where('specimenId').anyOf(ids).toArray()
        const storageBySpecimen = new Map<string, Storage>()
        storagesOf.forEach((storage) => storageBySpecimen.set(storage.specimenId, storage))

        const loans: Loan[] = specimens.map((specimen: Specimen) => {
          const storage = storageBySpecimen.get(specimen.id)
          return {
            id: uid('loan'),
            specimenId: specimen.id,
            borrower: borrower.trim(),
            loanDate,
            dueDate,
            phase: '借出',
            origin: storage
              ? {
                  cabinet: storage.cabinet,
                  drawer: storage.drawer,
                  box: storage.box,
                  slot: storage.slot,
                  method: storage.method,
                  storageId: storage.id,
                  storedDate: storage.storedDate,
                  handler: storage.handler
                }
              : null,
            returnedDate: '',
            shelvedDate: '',
            note: note.trim()
          }
        })

        // 释放柜位 + 登记外借在同一事务内：任一写入失败整体回滚
        await db.storages.where('specimenId').anyOf(ids).delete()
        await db.loans.bulkPut(loans)
        return { loaned: loans }
      })

      await Promise.all([storageStore.getState().hydrate(), loanStore.getState().hydrate()])
      return { loaned: result.loaned }
    } catch (error) {
      // 事务已整体回滚；内存镜像也回到写入前，重试不会多出记录
      await rehydrateAfterFailure()
      throw error
    }
  },

  returnMany: async (specimenIds, returnedDate) => {
    const ids = Array.from(new Set(specimenIds))
    if (ids.length === 0) throw new Error('请选择需要归还的标本')

    try {
      const result = await db.transaction('rw', [db.storages, db.loans], async () => {
        const loans = await db.loans
          .where('specimenId')
          .anyOf(ids)
          .toArray()
          .then((rows) => rows.filter((row) => row.phase === '借出'))
        if (loans.length !== ids.length) throw new Error('选中的标本并非全部处于外借中，请刷新后重试')

        // 事务内重读柜位，决定回原位还是待归位
        const allStorages = await db.storages.toArray()
        // 已占用位置：含事务前柜位与本批次内即将放回的位置，避免同批两份标本归到同一插位
        const occupiedKeys = new Set(
          allStorages.map((storage) => encodeSlot(storage.cabinet, storage.drawer, storage.box, storage.slot))
        )

        const restored: Loan[] = []
        const pending: Loan[] = []
        const toShelve: Storage[] = []
        for (const loan of loans) {
          if (loan.origin) {
            const candidate = storageFromOrigin(loan)
            const key = encodeSlot(candidate.cabinet, candidate.drawer, candidate.box, candidate.slot)
            if (!occupiedKeys.has(key)) {
              // 原柜位空着：放回原位，沿用原 storage 记录 id
              toShelve.push(candidate)
              occupiedKeys.add(key)
              restored.push({ ...loan, phase: '已归还', returnedDate, shelvedDate: returnedDate })
              continue
            }
          } else {
            // 外借前本就未入柜：归还即完成，无需进待归位区
            restored.push({ ...loan, phase: '已归还', returnedDate, shelvedDate: returnedDate })
            continue
          }
          // 原柜位已被他人占用（含本批次先放回的另一份）：进入待归位区并保留原柜位，不挤掉现有标本
          pending.push({ ...loan, phase: '归还待归位', returnedDate })
        }

        await db.storages.bulkPut(toShelve)
        await db.loans.bulkPut([...restored, ...pending])
        return { restored, pending }
      })

      await Promise.all([storageStore.getState().hydrate(), loanStore.getState().hydrate()])
      return result
    } catch (error) {
      // 事务回滚：原柜位、借出状态、待归还清单都保持归还前
      await rehydrateAfterFailure()
      throw error
    }
  },

  reshelvePending: async ({ loanId, cabinet, drawer, box, slot, method, handler }) => {
    try {
      const updated = await db.transaction('rw', [db.storages, db.loans], async () => {
        const loan = await db.loans.get(loanId)
        if (!loan) throw new Error('借还记录不存在，请刷新后重试')
        if (loan.phase !== '归还待归位') throw new Error('该标本不在待归位区')

        const key = encodeSlot(cabinet, drawer, box, slot)
        const conflict = (await db.storages.toArray()).find(
          (storage) => encodeSlot(storage.cabinet, storage.drawer, storage.box, storage.slot) === key
        )
        if (conflict) throw new Error(`柜位 ${key} 已被占用，请选择其他空插位`)

        const today = new Date().toISOString().slice(0, 10)
        // 放回原柜位时沿用原 storage 记录 id；改放新柜位则新建记录
        const sameAsOrigin =
          loan.origin !== null &&
          loan.origin.cabinet.toUpperCase() === cabinet.toUpperCase() &&
          loan.origin.drawer === drawer &&
          loan.origin.box === box &&
          loan.origin.slot === slot
        const storage: Storage = sameAsOrigin
          ? { ...storageFromOrigin(loan) }
          : {
              id: uid('stg'),
              specimenId: loan.specimenId,
              method,
              cabinet,
              drawer,
              box,
              slot,
              storedDate: today,
              handler: handler.trim()
            }
        const settled: Loan = { ...loan, phase: '已归还', shelvedDate: today }

        await db.storages.put(storage)
        await db.loans.put(settled)
        return settled
      })

      await Promise.all([storageStore.getState().hydrate(), loanStore.getState().hydrate()])
      return updated
    } catch (error) {
      await rehydrateAfterFailure()
      throw error
    }
  },

  remove: async (id) => {
    await db.loans.delete(id)
    await loanStore.getState().hydrate()
  }
}))
