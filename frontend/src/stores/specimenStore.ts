import { create } from 'zustand'
import type { DetStatus, Specimen } from '@/types'
import { db, deleteRow, loadAll, putRow, putRows } from '@/hooks/usePersistentStore'

export interface SpecimenState {
  rows: Specimen[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: Specimen) => Promise<void>
  saveMany: (rows: Specimen[]) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetStatus: (ids: string[], status: DetStatus) => Promise<void>
  codes: () => string[]
}

export const specimenStore = create<SpecimenState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Specimen>(db.specimens)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<Specimen>(db.specimens, row)
    await get().hydrate()
  },
  saveMany: async (rows) => {
    if (rows.length === 0) return
    await putRows<Specimen>(db.specimens, rows)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<Specimen>(db.specimens, id)
    await get().hydrate()
  },
  bulkSetStatus: async (ids, status) => {
    // 外借中的标本不在馆，其鉴定状态不能被推进
    const openLoans = await db.loans.where('status').equals('外借').toArray()
    const loanedIds = new Set(openLoans.map((loan) => loan.specimenId))
    const blocked = [...new Set(ids)].filter((id) => loanedIds.has(id))
    if (blocked.length > 0) {
      const codeOf = (id: string): string => get().rows.find((row) => row.id === id)?.code ?? id
      throw new Error(`以下标本正在外借，不能推进鉴定状态：${blocked.map(codeOf).join('、')}`)
    }
    const targets = get().rows.filter((row) => ids.includes(row.id))
    await putRows<Specimen>(
      db.specimens,
      targets.map((row) => ({ ...row, status }))
    )
    await get().hydrate()
  },
  codes: () => get().rows.map((row) => row.code)
}))
