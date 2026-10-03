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
import { buildCustodyMaps, custodyOfSpecimen, type Custody } from '@/utils/custody'
import { encodeSlot, findSlotConflicts, specimenTaxon, storageSlotText } from '@/utils/codec'
import { uid } from '@/utils/id'

const todayStr = (): string => new Date().toISOString().slice(0, 10)
const defaultDueDate = (): string => {
  const date = new Date()
  date.setDate(date.getDate() + 30)
  return date.toISOString().slice(0, 10)
}

/** 保藏柜位图：柜-抽屉-盒-位三级展开；多选外借释放柜位，归还后原位优先、占用则进待归位区 */
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
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)

  // 批量外借
  const [checkoutIds, setCheckoutIds] = useState<string[]>([])
  const [borrower, setBorrower] = useState('')
  const [loanDate, setLoanDate] = useState(todayStr())
  const [dueDate, setDueDate] = useState(defaultDueDate())
  const [loanNote, setLoanNote] = useState('')
  // 批量归还
  const [returnIds, setReturnIds] = useState<string[]>([])

  const codeOf = (specimenId: string): string => specimens.find((item) => item.id === specimenId)?.code ?? '未知标本'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'

  const custodyMaps = useMemo(() => buildCustodyMaps(loans), [loans])
  const custodyOf = (specimenId: string): Custody => custodyOfSpecimen(custodyMaps, specimenId)
  const storageOf = useMemo(() => new Map(storages.map((item) => [item.specimenId, item])), [storages])

  const activeLoans = useMemo(() => loans.filter((item) => item.phase === '借出'), [loans])
  const pendingLoans = useMemo(() => loans.filter((item) => item.phase === '归还待归位'), [loans])

  const counts = useMemo(() => {
    let onShelf = 0
    let onLoan = 0
    let pending = 0
    specimens.forEach((specimen) => {
      const custody = custodyOf(specimen.id)
      if (custody === '外借') onLoan += 1
      else if (custody === '待归位') pending += 1
      else onShelf += 1
    })
    return { onShelf, onLoan, pending }
  }, [specimens, custodyMaps])

  /** 未入柜：必须在库；外借与待归位标本不出现在可入柜列表里 */
  const unplaced = specimens.filter((item) => !storageOf.has(item.id) && custodyOf(item.id) === '在库')
  /** 可外借：所有在库标本（含已入柜与未入柜） */
  const checkoutCandidates = specimens.filter((item) => custodyOf(item.id) === '在库')
  const checkoutSet = useMemo(() => new Set(checkoutIds), [checkoutIds])
  const returnSet = useMemo(() => new Set(returnIds), [returnIds])

  const originSlotText = (loan: Loan): string =>
    loan.origin ? encodeSlot(loan.origin.cabinet, loan.origin.drawer, loan.origin.box, loan.origin.slot) : '外借前未入柜'

  const flash = (text: string): void => {
    setMessage(text)
    setWarning('')
    setError('')
  }
  const fail = (text: string): void => {
    setError(text)
    setWarning('')
    setMessage('')
  }

  const place = async (position: { cabinet: string; drawer: number; box: number; slot: number }): Promise<void> => {
    const specimenId = dragging ?? picked
    if (!specimenId) {
      setWarning('请先在右侧选择或拖动一份标本')
      return
    }
    const custody = custodyOf(specimenId)

    // 待归位标本落位：原柜位或新空插位均可，全程事务，占用冲突由事务兜底
    if (custody === '待归位') {
      const loan = custodyMaps.activeBySpecimen.get(specimenId)
      if (!loan) {
        fail('找不到该标本的归还记录，请刷新后重试')
        return
      }
      const targetKey = encodeSlot(position.cabinet, position.drawer, position.box, position.slot)
      const occupied = storages.some(
        (item) => encodeSlot(item.cabinet, item.drawer, item.box, item.slot) === targetKey
      )
      if (occupied) {
        setWarning(`柜位 ${targetKey} 已被占用，请选择其他空插位，待归位标本不会挤掉现有标本`)
        return
      }
      try {
        await loanStore.getState().reshelvePending({
          loanId: loan.id,
          cabinet: position.cabinet,
          drawer: position.drawer,
          box: position.box,
          slot: position.slot,
          method: loan.origin?.method ?? method,
          handler: handler.trim() || loan.origin?.handler || ''
        })
        const backToOrigin = originSlotText(loan) === targetKey
        flash(`${codeOf(specimenId)} 已${backToOrigin ? '放回原柜位' : '归位'} ${targetKey}`)
      } catch (caught) {
        fail(caught instanceof Error ? caught.message : '归位写入失败，已保持待归位状态，请重试')
      }
      setPicked('')
      setDragging(null)
      return
    }

    if (custody === '外借') {
      setWarning(`${codeOf(specimenId)} 外借中，归还前不能入柜`)
      return
    }

    const candidate: Storage = {
      id: storageOf.get(specimenId)?.id ?? uid('stg'),
      specimenId,
      method,
      cabinet: position.cabinet,
      drawer: position.drawer,
      box: position.box,
      slot: position.slot,
      storedDate: todayStr(),
      handler: handler.trim()
    }
    const conflicts = findSlotConflicts(storages, candidate)
    if (conflicts.length > 0) {
      setWarning(
        `柜位 ${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)} 已被占用：` +
          conflicts.map((item) => `${codeOf(item.specimenId)}（${item.method}）`).join('、') +
          '，请换一个插位或先出柜'
      )
      return
    }
    setWarning('')
    await storageStore.getState().save(candidate)
    flash(`${codeOf(specimenId)} 已入柜 ${storageSlotText(candidate)}`)
    setPicked('')
    setDragging(null)
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().remove(storage.id)
    flash(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜`)
    setDetail(null)
  }

  const toggleCheckout = (id: string): void => {
    setCheckoutIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }
  const toggleReturn = (id: string): void => {
    setReturnIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const confirmCheckout = async (): Promise<void> => {
    if (checkoutIds.length === 0) {
      setWarning('请先勾选需要外借的在库标本')
      return
    }
    try {
      const { loaned } = await loanStore.getState().checkoutMany({
        specimenIds: checkoutIds,
        borrower: borrower.trim(),
        loanDate,
        dueDate,
        note: loanNote
      })
      flash(`已登记外借 ${loaned.length} 份（借用人 ${borrower.trim()}，期限至 ${dueDate}），原柜位已释放`)
      setCheckoutIds([])
      setBorrower('')
      setLoanNote('')
    } catch (caught) {
      fail(
        caught instanceof Error
          ? `外借登记失败，已恢复原柜位与借出状态：${caught.message}`
          : '外借登记失败，已恢复原柜位与借出状态，请重试'
      )
    }
  }

  const confirmReturn = async (overrideIds?: string[]): Promise<void> => {
    const ids = overrideIds ?? returnIds
    if (ids.length === 0) {
      setWarning('请先勾选需要归还的外借标本')
      return
    }
    try {
      const { restored, pending } = await loanStore.getState().returnMany(ids, todayStr())
      const parts: string[] = []
      if (restored.length > 0) parts.push(`${restored.length} 份原柜位空着已放回`)
      if (pending.length > 0) parts.push(`${pending.length} 份原柜位被占用进入待归位区`)
      flash(`归还 ${ids.length} 份：${parts.join('，') || '无变更'}`)
      setReturnIds([])
    } catch (caught) {
      fail(
        caught instanceof Error
          ? `归还失败，借出状态与待归还清单已恢复：${caught.message}`
          : '归还失败，借出状态与待归还清单已恢复，请重试'
      )
    }
  }

  const draggingLabel = dragging
    ? `${codeOf(dragging)}（${custodyOf(dragging)}）`
    : picked
      ? `${codeOf(picked)}（${custodyOf(picked)}）`
      : null

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">保藏柜位图</h1>
        <p className="page-sub">
          柜—抽屉—盒三级展开插位，空位虚线显示；在库标本可拖拽入柜，勾选多份可整批外借并释放柜位，归还时原柜位优先、被占用则进待归位区。
        </p>
      </header>

      <section className="panel flex flex-wrap items-center gap-4 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <CustodyTag custody="在库" /> <b>{counts.onShelf}</b> 份
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CustodyTag custody="外借" /> <b>{counts.onLoan}</b> 份
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CustodyTag custody="待归位" /> <b>{counts.pending}</b> 份
        </span>
        <span className="text-xs text-slate-500">
          柜内实际占用 {storages.length} 个位 · 在库未入柜 {unplaced.length} 份
        </span>
      </section>

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
          {draggingLabel ? `当前选中 ${draggingLabel}，点击插位落位` : '从右侧未入柜或待归位列表拖动标本到插位'}
        </div>
      </section>

      {error ? <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null}
      {warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <CabinetGrid
          cabinet={cabinet}
          drawers={drawers}
          boxes={boxes}
          slots={slots}
          storages={storages}
          codeOf={codeOf}
          draggingCode={draggingLabel}
          onDropSlot={(position) => void place(position)}
          onPickStorage={(storage) => setDetail(storage)}
        />

        <div className="flex flex-col gap-4">
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">未入柜标本（在库，拖到插位）</h2>
            <div className="mt-2 max-h-60 space-y-2 overflow-auto">
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
              {unplaced.length === 0 ? <p className="text-xs text-slate-400">在库标本都已入柜</p> : null}
            </div>
          </div>

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">已入柜明细</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <span>
                    <span className="font-mono text-field-700">{storageSlotText(storage)}</span>
                    <span className="ml-2 text-slate-600">{codeOf(storage.specimenId)}</span>
                    <span className="ml-1 text-slate-400">{storage.method}</span>
                  </span>
                  <button className="btn-danger" type="button" onClick={() => void takeOut(storage)}>
                    出柜
                  </button>
                </li>
              ))}
              {storages.length === 0 ? <li className="text-slate-400">暂无入柜记录</li> : null}
            </ul>
          </div>

          {detail ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">插位明细</h2>
              <p className="mt-1 text-xs text-slate-600">
                柜位 {storageSlotText(detail)} · {detail.method} · 入柜日期 {detail.storedDate} · 经手人{' '}
                {detail.handler || '—'}
              </p>
              <p className="text-xs text-slate-600">标本：{codeOf(detail.specimenId)}</p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {/* 待归位区：保留原柜位，拖到空插位（含空出来的原柜位）完成归位，不挤掉占用者 */}
        <div className="panel">
          <h2 className="text-sm font-semibold text-slate-700">
            待归位区（{pendingLoans.length}）
            <span className="ml-2 font-normal text-xs text-slate-400">归还时原柜位已被占用；拖到任一空插位归位，原柜位保留显示</span>
          </h2>
          <div className="mt-2 max-h-72 space-y-2 overflow-auto">
            {pendingLoans.map((loan) => {
              const specimen = specimens.find((item) => item.id === loan.specimenId)
              const originKey = originSlotText(loan)
              const originTaken =
                loan.origin !== null &&
                storages.some(
                  (item) =>
                    encodeSlot(item.cabinet, item.drawer, item.box, item.slot) ===
                    encodeSlot(loan.origin!.cabinet, loan.origin!.drawer, loan.origin!.box, loan.origin!.slot)
                )
              return (
                <div
                  key={loan.id}
                  draggable
                  onDragStart={() => setDragging(loan.specimenId)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => setPicked(loan.specimenId)}
                  className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                    dragging === loan.specimenId || picked === loan.specimenId
                      ? 'border-amber-500 bg-amber-50'
                      : 'border-amber-200 bg-amber-50/40 hover:bg-amber-50'
                  }`}
                >
                  <p className="flex items-center justify-between gap-2">
                    <span className="font-mono text-amber-800">{codeOf(loan.specimenId)}</span>
                    <CustodyTag custody="待归位" />
                  </p>
                  <p className="mt-0.5 text-slate-600">{specimen ? specimenTaxon(specimen) : '—'}</p>
                  <p className="text-slate-500">
                    原柜位 <span className="font-mono">{originKey}</span>
                    {originTaken ? <span className="text-amber-700">（被占用）</span> : <span className="text-emerald-700">（现已空出）</span>}
                  </p>
                  <p className="text-slate-400">
                    借用人 {loan.borrower} · 归还登记 {loan.returnedDate || '—'}
                  </p>
                </div>
              )
            })}
            {pendingLoans.length === 0 ? <p className="text-xs text-slate-400">暂无待归位标本</p> : null}
          </div>
        </div>

        {/* 外借中：勾选后批量归还，也可单份归还 */}
        <div className="panel">
          <h2 className="text-sm font-semibold text-slate-700">外借中（{activeLoans.length}）</h2>
          <div className="mt-2 max-h-72 space-y-2 overflow-auto">
            {activeLoans.map((loan) => {
              const overdue = loan.dueDate < todayStr()
              return (
                <label
                  key={loan.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-violet-600"
                    checked={returnSet.has(loan.specimenId)}
                    onChange={() => toggleReturn(loan.specimenId)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-violet-800">{codeOf(loan.specimenId)}</span>
                      <CustodyTag custody="外借" />
                    </span>
                    <span className="mt-0.5 block text-slate-600">
                      借用人 {loan.borrower} · 期限 {loan.dueDate}
                      {overdue ? <span className="ml-1 font-semibold text-red-600">已逾期</span> : null}
                    </span>
                    <span className="block text-slate-400">
                      原柜位 <span className="font-mono">{originSlotText(loan)}</span> · 借出 {loan.loanDate}
                      {loan.note ? ` · ${loan.note}` : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn-ghost shrink-0"
                    onClick={() => void confirmReturn([loan.specimenId])}
                  >
                    归还
                  </button>
                </label>
              )
            })}
            {activeLoans.length === 0 ? <p className="text-xs text-slate-400">当前没有外借中的标本</p> : null}
          </div>
          <button className="btn-primary mt-3" type="button" disabled={returnIds.length === 0} onClick={() => void confirmReturn()}>
            归还选中的 {returnIds.length} 份（原柜位空则放回，占用则进待归位区）
          </button>
        </div>
      </section>

      {/* 批量外借：选中多份在库标本，登记借用人/期限，记录原柜位并释放 */}
      <section className="panel">
        <h2 className="text-sm font-semibold text-slate-700">批量确认外借（{checkoutIds.length} 份已选）</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div>
            <span className="field-label">借用人 / 外单位</span>
            <input className="field-input" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="如 黔灵昆虫研究所 · 孟昭" />
          </div>
          <div>
            <span className="field-label">借出日期</span>
            <input type="date" className="field-input" value={loanDate} onChange={(e) => setLoanDate(e.target.value)} />
          </div>
          <div>
            <span className="field-label">归还期限</span>
            <input type="date" className="field-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <span className="field-label">备注</span>
            <input className="field-input" value={loanNote} onChange={(e) => setLoanNote(e.target.value)} placeholder="如 比较研究 / 展览" />
          </div>
        </div>
        <div className="mt-3 max-h-64 space-y-1.5 overflow-auto rounded-lg border border-slate-200 p-2">
          {checkoutCandidates.map((specimen) => {
            const storage = storageOf.get(specimen.id)
            return (
              <label
                key={specimen.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-field-600"
                  checked={checkoutSet.has(specimen.id)}
                  onChange={() => toggleCheckout(specimen.id)}
                />
                <span className="font-mono text-field-700">{specimen.code}</span>
                <span className="text-slate-600">{specimenTaxon(specimen)}</span>
                <span className="ml-auto text-slate-400">
                  柜位 <span className="font-mono">{storage ? storageSlotText(storage) : '未入柜'}</span>
                </span>
              </label>
            )
          })}
          {checkoutCandidates.length === 0 ? <p className="text-xs text-slate-400">没有可外借的在库标本</p> : null}
        </div>
        <button className="btn-primary mt-3" type="button" disabled={checkoutIds.length === 0} onClick={() => void confirmCheckout()}>
          确认外借选中的 {checkoutIds.length} 份（记录借用人/期限/原柜位并释放柜位）
        </button>
      </section>
    </div>
  )
}
