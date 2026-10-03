import type { CustodyStatus, Loan } from '@/types'

/** 未结清的借还状态：标本物理上不在柜内 */
export const OPEN_LOAN_STATUSES = ['外借', '待归位'] as const

/** 判断借还记录是否尚未结清 */
export function isOpenLoan(loan: Loan): boolean {
  return (OPEN_LOAN_STATUSES as readonly string[]).includes(loan.status)
}

/**
 * 取每份标本当前生效的借还记录（外借 / 待归位至多一条）。
 * 已归还记录不参与保管状态，旧数据没有任何借还记录时自然落到「在库」。
 */
export function activeLoansBySpecimen(loans: Loan[]): Map<string, Loan> {
  const map = new Map<string, Loan>()
  for (const loan of loans) {
    if (!isOpenLoan(loan)) continue
    const prev = map.get(loan.specimenId)
    if (!prev || loan.loanDate + loan.id > prev.loanDate + prev.id) {
      map.set(loan.specimenId, loan)
    }
  }
  return map
}

/** 由借还记录派生标本保管状态；无未结清记录即为「在库」（旧数据兼容） */
export function custodyOf(specimenId: string, active: Map<string, Loan>): CustodyStatus {
  const loan = active.get(specimenId)
  if (!loan) return '在库'
  return loan.status === '待归位' ? '待归位' : '外借'
}

/** 是否逾期（应还日期早于今天且仍在外借） */
export function isLoanOverdue(loan: Loan, today = new Date().toISOString().slice(0, 10)): boolean {
  return loan.status === '外借' && !!loan.dueDate && loan.dueDate < today
}
