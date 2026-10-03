import { create } from 'zustand'
import type { Determination } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'

export interface DeterminationState {
  rows: Determination[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: Determination) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const determinationStore = create<DeterminationState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Determination>(db.determinations)
    rows.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    // 外借期间标本不在馆，不允许新增鉴定记录（待归位标本已回馆，不受限）
    const loans = await db.loans.where('specimenId').equals(row.specimenId).toArray()
    const openLoan = loans.find((loan) => loan.status === '外借')
    if (openLoan) {
      throw new Error(`该标本正在外借（借用人 ${openLoan.borrower}），归还前不能新增鉴定`)
    }
    await putRow<Determination>(db.determinations, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<Determination>(db.determinations, id)
    await get().hydrate()
  }
}))
