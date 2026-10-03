/** 借还状态（同一标本同一时刻至多有一条未结清记录：外借 / 待归位） */
export const LOAN_STATUSES = ['外借', '待归位', '已归还'] as const
export type LoanStatus = (typeof LOAN_STATUSES)[number]

/**
 * 派生自借还记录的标本保管状态：
 * - 在库：无未结清借还记录（旧数据升级后没有借还记录，按在库兼容处理）
 * - 外借：存在「外借」记录
 * - 待归位：已归还但原柜位被占，停留在待归位区
 */
export const CUSTODY_STATUSES = ['在库', '外借', '待归位'] as const
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number]

/** 借出时柜位快照：柜位记录已释放，归还要靠它放回原位 */
export interface StorageSnapshot {
  /** 当时的保藏记录 ID，归还时按同一 ID 重建，重试不会多出记录 */
  storageId: string
  method: StorageSnapshotMethod
  cabinet: string
  drawer: number
  box: number
  slot: number
}

/** 保藏方式镜像（避免 loan 表与 storage 表的字面量类型耦合） */
export type StorageSnapshotMethod = '针插' | '浸液' | '玻片' | '干燥'

/** Loan 借还记录 */
export interface Loan {
  id: string
  /** 借出单号，展示用 */
  code: string
  specimenId: string
  borrower: string
  /** 借用单位 */
  organization: string
  /** 借出日期 */
  loanDate: string
  /** 应还日期（期限） */
  dueDate: string
  /** 实际归还登记日期；待归位期间也记录归还动作日期 */
  returnedDate: string
  /** 外借 / 待归位 / 已归还 */
  status: LoanStatus
  /** 借出时的原柜位快照；在库标本未入柜时不允许借出，故始终有值 */
  origin: StorageSnapshot
  handler: string
  note: string
}
