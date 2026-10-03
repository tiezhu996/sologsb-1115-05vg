import type { Loan } from '@/types'

/** 保管状态：在库 / 外借 / 待归位 */
export type Custody = '在库' | '外借' | '待归位'

export const CUSTODIES: Custody[] = ['在库', '外借', '待归位']

export interface CustodyMaps {
  /** 标本 id → 有效借还记录（借出中 或 归还待归位） */
  activeBySpecimen: Map<string, Loan>
  /** 标本 id → 保管状态，含活跃借还记录的标本 */
  custodyOf: Map<string, Custody>
}

/**
 * 依据借还记录派生保管状态：
 * - 「借出」记录 → 外借；「归还待归位」记录 → 待归位；
 * - 没有借还记录的标本（含旧数据）一律按在库兼容处理。
 */
export function buildCustodyMaps(loans: Loan[]): CustodyMaps {
  const activeBySpecimen = new Map<string, Loan>()
  for (const loan of loans) {
    if (loan.phase === '借出' || loan.phase === '归还待归位') {
      // 同一标本至多一条活跃记录；若历史数据出现重复，保留更新时间更晚的一条
      const prev = activeBySpecimen.get(loan.specimenId)
      if (!prev || loan.loanDate + loan.id > prev.loanDate + prev.id) {
        activeBySpecimen.set(loan.specimenId, loan)
      }
    }
  }
  const custodyOf = new Map<string, Custody>()
  activeBySpecimen.forEach((loan, specimenId) => {
    custodyOf.set(specimenId, loan.phase === '借出' ? '外借' : '待归位')
  })
  return { activeBySpecimen, custodyOf }
}

/** 标本保管状态（无活跃借还记录即在库） */
export function custodyOfSpecimen(maps: CustodyMaps, specimenId: string): Custody {
  return maps.custodyOf.get(specimenId) ?? '在库'
}

/** 标本是否外借中（外借期间禁止入柜、禁止新增鉴定） */
export function isOnLoan(maps: CustodyMaps, specimenId: string): boolean {
  return maps.custodyOf.get(specimenId) === '外借'
}
