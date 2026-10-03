import type { StorageMethod } from './storage'

/** 借还记录状态（生命周期） */
export const LOAN_PHASES = ['借出', '归还待归位', '已归还'] as const
export type LoanPhase = (typeof LOAN_PHASES)[number]

/** 外借时的原柜位快照：归还时据此尝试放回原位 */
export interface LoanOrigin {
  cabinet: string
  drawer: number
  box: number
  slot: number
  method: StorageMethod
  /** 原入柜记录 id，回原柜位时沿用同一条记录 */
  storageId: string
  storedDate: string
  handler: string
}

/** Loan 外借 / 归还记录 */
export interface Loan {
  id: string
  specimenId: string
  /** 借用人（外单位 / 经手人） */
  borrower: string
  /** 借出日期 */
  loanDate: string
  /** 归还期限 */
  dueDate: string
  phase: LoanPhase
  /** 外借时的原柜位；外借前未入柜的标本为 null */
  origin: LoanOrigin | null
  /** 实际归还登记日期（未归还为空） */
  returnedDate: string
  /** 归位入柜日期（已放回柜中或本就无柜位时填写） */
  shelvedDate: string
  note: string
}
