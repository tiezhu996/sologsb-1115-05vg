import type { CustodyStatus } from '@/types'

const STYLES: Record<CustodyStatus, string> = {
  在库: 'bg-field-50 text-field-700 border-field-300',
  外借: 'bg-violet-50 text-violet-700 border-violet-300',
  待归位: 'bg-amber-50 text-amber-700 border-amber-300'
}

const DOTS: Record<CustodyStatus, string> = {
  在库: 'bg-field-500',
  外借: 'bg-violet-500',
  待归位: 'bg-amber-500'
}

export interface CustodyTagProps {
  status: CustodyStatus
  withDot?: boolean
  className?: string
}

/** 保管状态标签：在库 / 外借 / 待归位，柜位图、标本清单、鉴定页共用同一派生结果 */
export default function CustodyTag({ status, withDot = true, className = '' }: CustodyTagProps): JSX.Element {
  return (
    <span
      data-testid="custody-tag"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs leading-5 ${STYLES[status]} ${className}`}
    >
      {withDot ? <i className={`h-1.5 w-1.5 rounded-full ${DOTS[status]}`} /> : null}
      {status}
    </span>
  )
}
