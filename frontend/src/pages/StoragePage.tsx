import { useMemo, useState } from 'react'
import type { Loan, Storage, StorageMethod } from '@/types'
import { STORAGE_METHODS } from '@/types'
import CabinetGrid from '@/components/common/CabinetGrid'
import StatusTag from '@/components/common/StatusTag'
import CustodyTag from '@/components/common/CustodyTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { siteStore } from '@/stores/siteStore'
import { loanStore } from '@/stores/loanStore'
import { encodeSlot, specimenTaxon, storageSlotText } from '@/utils/codec'
import { custodyOf, isLoanOverdue } from '@/utils/custody'
import { uid } from '@/utils/id'

interface Position {
  cabinet: string
  drawer: number
  box: number
  slot: number
}

/** 原柜位文本（借还记录保存的是柜位快照，不依赖柜位记录是否还在） */
function originSlotText(loan: Loan): string {
  return encodeSlot(loan.origin.cabinet, loan.origin.drawer, loan.origin.box, loan.origin.slot)
}

/** 保藏柜位图：柜-抽屉-盒-位三级展开；外借释放柜位，归还优先回原柜位，被占则入待归位区 */
export default function StoragePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)
  const loans = usePersistentStore(loanStore, (state) => state.rows)

  const [cabinet, setCabinet] = useState('C01')
  const [drawers, setDrawers] = useState(2)
  const [boxes, setBoxes] = useState(3)
  const [slots, setSlots] = useState(8)
  const [method, setMethod] = useState<StorageMethod>('针插')
  const [handler, setHandler] = useState('')
  const [picked, setPicked] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)

  /** 外借登记表单 */
  const [lendChecked, setLendChecked] = useState<string[]>([])
  const [borrower, setBorrower] = useState('')
  const [organization, setOrganization] = useState('')
  const [loanDate, setLoanDate] = useState(new Date().toISOString().slice(0, 10))
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
  )
  const [lendHandler, setLendHandler] = useState('')
  const [lendNote, setLendNote] = useState('')
  const [busy, setBusy] = useState(false)

  /** 外借清单勾选（批量归还） */
  const [returnChecked, setReturnChecked] = useState<string[]>([])
  const [returnHandler, setReturnHandler] = useState('')

  const codeOf = (specimenId: string): string => specimens.find((item) => item.id === specimenId)?.code ?? '未知'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'

  /** 保管状态的唯一派生口径：借还记录 → 在库 / 外借 / 待归位（无借还记录的旧数据按在库） */
  const activeLoanMap = useMemo(() => {
    const map = new Map<string, Loan>()
    loans
      .filter((loan) => loan.status === '外借' || loan.status === '待归位')
      .forEach((loan) => map.set(loan.specimenId, loan))
    return map
  }, [loans])
  const custody = (specimenId: string) => custodyOf(specimenId, activeLoanMap)

  const placedIds = useMemo(() => new Set(storages.map((item) => item.specimenId)), [storages])
  const onLoan = loans.filter((loan) => loan.status === '外借')
  const pendingRestore = loans.filter((loan) => loan.status === '待归位')

  // 可入柜拖放：在库且尚未入柜；外借标本不能入柜，待归位标本允许手工改放新位
  const unplaced = specimens.filter((item) => !placedIds.has(item.id) && !activeLoanMap.has(item.id))

  const notify = (text: string): void => {
    setMessage(text)
    setWarning('')
  }
  const fail = (text: string): void => {
    setWarning(text)
    setMessage('')
  }

  const place = async (position: Position): Promise<void> => {
    const specimenId = dragging ?? picked
    if (!specimenId) {
      fail('请先在右侧选择或拖动一份未入柜标本（待归位标本也可直接拖到新柜位）')
      return
    }
    if (custody(specimenId) === '外借') {
      fail(`${codeOf(specimenId)} 正在外借，归还前不能入柜`)
      return
    }
    const candidate: Storage = {
      id: storages.find((item) => item.specimenId === specimenId)?.id ?? uid('stg'),
      specimenId,
      method,
      cabinet: position.cabinet,
      drawer: position.drawer,
      box: position.box,
      slot: position.slot,
      storedDate: new Date().toISOString().slice(0, 10),
      handler: handler.trim()
    }
    try {
      // 柜位冲突、外借拦截、待归位结清都在同一事务里完成，失败整体回滚
      await loanStore.getState().placeToStorage(candidate)
      const placedLoan = activeLoanMap.get(specimenId)
      notify(
        placedLoan?.status === '待归位'
          ? `${codeOf(specimenId)} 已放入 ${storageSlotText(candidate)}，借还单 ${placedLoan.code} 结清`
          : `${codeOf(specimenId)} 已入柜 ${storageSlotText(candidate)}`
      )
      setPicked('')
      setDragging(null)
    } catch (error) {
      fail(error instanceof Error ? error.message : '入柜失败，已恢复事务前状态')
    }
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().remove(storage.id)
    notify(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜`)
    setDetail(null)
    setLendChecked((prev) => prev.filter((id) => id !== storage.specimenId))
  }

  const toggleLend = (specimenId: string): void => {
    setLendChecked((prev) => (prev.includes(specimenId) ? prev.filter((id) => id !== specimenId) : [...prev, specimenId]))
  }

  const confirmLend = async (): Promise<void> => {
    if (busy) return
    if (lendChecked.length === 0) {
      fail('请先勾选要整批外借的在柜标本')
      return
    }
    setBusy(true)
    try {
      const created = await loanStore.getState().lendMany(lendChecked, {
        borrower,
        organization,
        loanDate,
        dueDate,
        handler: lendHandler,
        note: lendNote
      })
      notify(
        `已借出 ${created.length} 份（单号 ${created[0]?.code ?? '—'}），原柜位已释放：` +
          created.map((loan) => `${codeOf(loan.specimenId)}←${originSlotText(loan)}`).join('、')
      )
      setLendChecked([])
      setBorrower('')
      setOrganization('')
      setLendNote('')
    } catch (error) {
      fail(error instanceof Error ? error.message : '外借登记失败，已恢复原柜位与借出状态')
    } finally {
      setBusy(false)
    }
  }

  const toggleReturn = (specimenId: string): void => {
    setReturnChecked((prev) => (prev.includes(specimenId) ? prev.filter((id) => id !== specimenId) : [...prev, specimenId]))
  }

  const confirmReturn = async (): Promise<void> => {
    if (busy) return
    if (returnChecked.length === 0) {
      fail('请先勾选要归还的外借标本')
      return
    }
    setBusy(true)
    try {
      const result = await loanStore.getState().returnMany(returnChecked, returnHandler)
      const restoredText = result.restored.map((item) => `${codeOf(item.specimenId)}→${item.originSlot}`).join('、')
      const pendingText = result.pending.map((item) => `${codeOf(item.specimenId)}（原柜位 ${item.originSlot} 已占用）`).join('、')
      const parts: string[] = []
      if (result.restored.length > 0) parts.push(`已放回原柜位 ${result.restored.length} 份：${restoredText}`)
      if (result.pending.length > 0) parts.push(`原柜位被占，进入待归位区 ${result.pending.length} 份：${pendingText}`)
      notify(parts.join('；') || '所选标本均不在外借状态')
      setReturnChecked([])
    } catch (error) {
      fail(error instanceof Error ? error.message : '归还失败，已恢复借出状态与待归还清单')
    } finally {
      setBusy(false)
    }
  }

  const retryPending = async (specimenIds?: string[]): Promise<void> => {
    if (busy) return
    const ids = specimenIds ?? pendingRestore.map((loan) => loan.specimenId)
    if (ids.length === 0) {
      fail('待归位区没有标本')
      return
    }
    setBusy(true)
    try {
      const result = await loanStore.getState().retryRestore(ids)
      const parts: string[] = []
      if (result.restored.length > 0) {
        parts.push(
          `原柜位已空，归位 ${result.restored.length} 份：` +
            result.restored.map((item) => `${codeOf(item.specimenId)}→${item.originSlot}`).join('、')
        )
      }
      if (result.pending.length > 0) {
        parts.push(
          `原柜位仍被占用，继续等待 ${result.pending.length} 份：` +
            result.pending.map((item) => `${codeOf(item.specimenId)}（${item.originSlot}）`).join('、')
        )
      }
      notify(parts.join('；'))
    } catch (error) {
      fail(error instanceof Error ? error.message : '归位重试失败，状态未改变')
    } finally {
      setBusy(false)
    }
  }

  const lendCheckedSet = new Set(lendChecked)
  const returnCheckedSet = new Set(returnChecked)

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">保藏柜位图</h1>
        <p className="page-sub">
          在柜标本可整批勾选外借（登记借用人、期限，自动记录并释放原柜位）；归还时原柜位空着就放回，已被占用则进待归位区，不挤掉现有标本。
        </p>
      </header>

      <section className="panel flex flex-wrap items-end gap-3">
        <div>
          <span className="field-label">标本柜编号</span>
          <input className="field-input w-28" value={cabinet} onChange={(e) => setCabinet(e.target.value.toUpperCase())} />
        </div>
        <div>
          <span className="field-label">抽屉数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={drawers} onChange={(e) => setDrawers(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每屉盒数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={boxes} onChange={(e) => setBoxes(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每盒插位</span>
          <input type="number" min={1} max={20} className="field-input w-20" value={slots} onChange={(e) => setSlots(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">保藏方式</span>
          <select className="field-input w-28" value={method} onChange={(e) => setMethod(e.target.value as StorageMethod)}>
            {STORAGE_METHODS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="field-label">经手人</span>
          <input className="field-input w-32" value={handler} onChange={(e) => setHandler(e.target.value)} placeholder="如 覃羽" />
        </div>
        <div className="text-xs text-slate-500">
          在柜 {storages.length} 份 · 外借 {onLoan.length} 份 · 待归位 {pendingRestore.length} 份 · 可入柜 {unplaced.length} 份
          {picked ? ` · 当前选中 ${codeOf(picked)}` : ''}
        </div>
      </section>

      {warning ? <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <CabinetGrid
          cabinet={cabinet}
          drawers={drawers}
          boxes={boxes}
          slots={slots}
          storages={storages}
          codeOf={codeOf}
          draggingCode={dragging ? codeOf(dragging) : picked ? codeOf(picked) : null}
          onDropSlot={(position) => void place(position)}
          onPickStorage={(storage) => setDetail(storage)}
        />

        <div className="flex flex-col gap-4">
          <div className="panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">在柜标本（勾选后整批外借）</h2>
              <button
                className="btn-ghost text-xs"
                type="button"
                onClick={() =>
                  setLendChecked((prev) =>
                    prev.length === storages.length ? [] : storages.map((storage) => storage.specimenId)
                  )
                }
              >
                {lendChecked.length === storages.length && storages.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>
            <ul className="mt-2 max-h-64 space-y-1.5 overflow-auto text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={`选择外借 ${codeOf(storage.specimenId)}`}
                    className="h-4 w-4 accent-violet-600"
                    checked={lendCheckedSet.has(storage.specimenId)}
                    onChange={() => toggleLend(storage.specimenId)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-field-700">{codeOf(storage.specimenId)}</span>
                    <span className="block text-slate-400">
                      {storageSlotText(storage)} · {storage.method}
                    </span>
                  </span>
                  <button className="btn-danger px-2 py-1 text-xs" type="button" onClick={() => void takeOut(storage)}>
                    出柜
                  </button>
                </li>
              ))}
              {storages.length === 0 ? <li className="text-slate-400">暂无在柜标本</li> : null}
            </ul>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <span className="field-label">借用人 *</span>
                <input className="field-input" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="如 纪鸣" />
              </div>
              <div>
                <span className="field-label">借用单位</span>
                <input className="field-input" value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="如 省林科院" />
              </div>
              <div>
                <span className="field-label">借出日期 *</span>
                <input type="date" className="field-input" value={loanDate} onChange={(e) => setLoanDate(e.target.value)} />
              </div>
              <div>
                <span className="field-label">归还期限 *</span>
                <input type="date" className="field-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div>
                <span className="field-label">经手人</span>
                <input className="field-input" value={lendHandler} onChange={(e) => setLendHandler(e.target.value)} placeholder="如 覃羽" />
              </div>
              <div>
                <span className="field-label">备注</span>
                <input className="field-input" value={lendNote} onChange={(e) => setLendNote(e.target.value)} placeholder="借阅用途等" />
              </div>
            </div>
            <button className="btn-primary mt-3 w-full justify-center" type="button" disabled={busy} onClick={() => void confirmLend()}>
              确认外借（{lendChecked.length}）并释放原柜位
            </button>
          </div>

          <div className="panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">外借清单（{onLoan.length}）</h2>
              <button
                className="btn-ghost text-xs"
                type="button"
                onClick={() => {
                  const onLoanIds = onLoan.map((loan) => loan.specimenId)
                  setReturnChecked((prev) =>
                    prev.length === onLoanIds.length && onLoanIds.every((id) => prev.includes(id))
                      ? []
                      : onLoanIds
                  )
                }}
              >
                {returnChecked.length === onLoan.length && onLoan.length > 0 ? '取消全选' : '全选'}
              </button>
            </div>
            <ul className="mt-2 max-h-60 space-y-1.5 overflow-auto text-xs">
              {onLoan.map((loan) => {
                const overdue = isLoanOverdue(loan)
                return (
                  <li key={loan.id} className="rounded-lg border border-violet-200 bg-violet-50/50 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`选择归还 ${codeOf(loan.specimenId)}`}
                        className="h-4 w-4 accent-emerald-600"
                        checked={returnCheckedSet.has(loan.specimenId)}
                        onChange={() => toggleReturn(loan.specimenId)}
                      />
                      <span className="flex-1">
                        <span className="font-mono text-violet-700">{codeOf(loan.specimenId)}</span>
                        <span className="ml-2 text-slate-500">{loan.borrower}{loan.organization ? ` · ${loan.organization}` : ''}</span>
                      </span>
                      {overdue ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] text-rose-600">已逾期</span> : null}
                    </div>
                    <p className="mt-0.5 text-slate-500">
                      {loan.loanDate} 借出 · 应还 <span className={overdue ? 'font-semibold text-rose-600' : ''}>{loan.dueDate || '—'}</span> · 原柜位{' '}
                      <span className="font-mono">{originSlotText(loan)}</span> · 单号 {loan.code}
                    </p>
                  </li>
                )
              })}
              {onLoan.length === 0 ? <li className="text-slate-400">当前没有外借中的标本</li> : null}
            </ul>
            <div className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <span className="field-label">归还经手人</span>
                <input className="field-input" value={returnHandler} onChange={(e) => setReturnHandler(e.target.value)} placeholder="如 覃羽" />
              </div>
              <button className="btn-primary" type="button" disabled={busy} onClick={() => void confirmReturn()}>
                归还选中（{returnChecked.length}）
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400">归还时自动检查原柜位：空着即放回；已被新标本占用则进待归位区，不会挤掉现有标本。</p>
          </div>

          <div className="panel">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">待归位区（{pendingRestore.length}）</h2>
              {pendingRestore.length > 0 ? (
                <button className="btn-ghost text-xs" type="button" disabled={busy} onClick={() => void retryPending()}>
                  全部重试归位
                </button>
              ) : null}
            </div>
            <ul className="mt-2 max-h-52 space-y-1.5 overflow-auto text-xs">
              {pendingRestore.map((loan) => {
                const slotNow = storages.find(
                  (item) =>
                    encodeSlot(item.cabinet, item.drawer, item.box, item.slot) === originSlotText(loan) &&
                    item.specimenId !== loan.specimenId
                )
                return (
                  <li key={loan.id} className="rounded-lg border border-amber-300 bg-amber-50/60 px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-amber-800">{codeOf(loan.specimenId)}</span>
                      <button className="btn-ghost px-2 py-1 text-xs" type="button" disabled={busy} onClick={() => void retryPending([loan.specimenId])}>
                        试回原柜位
                      </button>
                    </div>
                    <p className="mt-0.5 text-slate-600">
                      原柜位 <span className="font-mono">{originSlotText(loan)}</span>
                      {slotNow ? <> 现由 {codeOf(slotNow.specimenId)} 占用</> : ' 现已空闲，可重试归位'}
                    </p>
                    <p className="text-slate-400">归还登记日 {loan.returnedDate || '—'} · 也可把它拖到其他空插位</p>
                  </li>
                )
              })}
              {pendingRestore.length === 0 ? <li className="text-slate-400">没有待归位标本</li> : null}
            </ul>
          </div>

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">可入柜 / 待归位标本（拖到插位）</h2>
            <div className="mt-2 max-h-60 space-y-2 overflow-auto">
              {pendingRestore.map((loan) => {
                const specimen = specimens.find((item) => item.id === loan.specimenId)
                return (
                  <div
                    key={loan.specimenId}
                    draggable
                    onDragStart={() => setDragging(loan.specimenId)}
                    onDragEnd={() => setDragging(null)}
                    onClick={() => setPicked(loan.specimenId)}
                    className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                      picked === loan.specimenId ? 'border-amber-500 bg-amber-50' : 'border-amber-300 bg-amber-50/40 hover:bg-amber-50'
                    }`}
                  >
                    <p className="flex items-center justify-between">
                      <span className="font-mono text-amber-800">{codeOf(loan.specimenId)}</span>
                      <CustodyTag status="待归位" />
                    </p>
                    {specimen ? <p className="text-slate-600">{specimenTaxon(specimen)}</p> : null}
                    <p className="text-slate-400">原柜位 {originSlotText(loan)}</p>
                  </div>
                )
              })}
              {unplaced.map((specimen) => (
                <div
                  key={specimen.id}
                  draggable
                  onDragStart={() => setDragging(specimen.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => setPicked(specimen.id)}
                  className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                    picked === specimen.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="font-mono text-field-700">{specimen.code}</p>
                  <p className="text-slate-600">{specimenTaxon(specimen)}</p>
                  <p className="text-slate-400">
                    {siteName(specimen.siteId)} · <StatusTag status={specimen.status} />
                  </p>
                </div>
              ))}
              {unplaced.length === 0 && pendingRestore.length === 0 ? (
                <p className="text-xs text-slate-400">没有可入柜的标本</p>
              ) : null}
            </div>
          </div>

          {detail ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">插位明细</h2>
              <p className="mt-1 text-xs text-slate-600">
                柜位 {storageSlotText(detail)} · {detail.method} · 入柜日期 {detail.storedDate} · 经手人{' '}
                {detail.handler || '—'} · <CustodyTag status={custody(detail.specimenId)} />
              </p>
              <p className="text-xs text-slate-600">标本：{codeOf(detail.specimenId)}</p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
