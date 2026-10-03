import 'fake-indexeddb/auto'
import { db } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { loanStore } from '@/stores/loanStore'
import { determinationStore } from '@/stores/determinationStore'
import { activeLoansBySpecimen, custodyOf } from '@/utils/custody'
import type { Loan, Storage } from '@/types'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function hydrateAll(): Promise<void> {
  await specimenStore.getState().hydrate()
  await storageStore.getState().hydrate()
  await loanStore.getState().hydrate()
  await determinationStore.getState().hydrate()
}

async function seed(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await db.specimens.bulkPut([
    {
      id: 'sp_a', code: 'QLB-2026-0001', order: '鞘翅目', family: '步甲科', genus: 'Carabus', species: '',
      tempName: '步甲', collectDate: today, collector: '陆昀', sex: '雄', stage: '成虫', bodyLength: 20,
      method: '徒手', quantity: 1, status: '初鉴', determiner: '', siteId: 'site_1', note: ''
    },
    {
      id: 'sp_b', code: 'QLB-2026-0002', order: '鳞翅目', family: '夜蛾科', genus: '', species: '',
      tempName: '夜蛾', collectDate: today, collector: '陆昀', sex: '未知', stage: '成虫', bodyLength: 15,
      method: '灯诱', quantity: 2, status: '待鉴定', determiner: '', siteId: 'site_1', note: ''
    },
    {
      id: 'sp_c', code: 'QLB-2026-0003', order: '双翅目', family: '摇蚊科', genus: '', species: '',
      tempName: '摇蚊', collectDate: today, collector: '蓝澈', sex: '未知', stage: '幼虫', bodyLength: 6,
      method: '扫网', quantity: 5, status: '待鉴定', determiner: '', siteId: 'site_1', note: ''
    }
  ])
  await db.storages.bulkPut([
    { id: 'stg_a', specimenId: 'sp_a', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1, storedDate: today, handler: '覃羽' },
    { id: 'stg_b', specimenId: 'sp_b', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2, storedDate: today, handler: '覃羽' },
    { id: 'stg_c', specimenId: 'sp_c', method: '浸液', cabinet: 'C02', drawer: 2, box: 3, slot: 4, storedDate: today, handler: '覃羽' }
  ])
  await hydrateAll()
}

async function resetDb(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()))
  await seed()
}

const lendInput = {
  borrower: '纪鸣',
  organization: '省林科院',
  loanDate: '2026-09-01',
  dueDate: '2026-09-20',
  handler: '覃羽',
  note: '比对用'
}

async function main(): Promise<void> {
  // ── 1. 旧数据兼容：没有借还记录一律在库 ──────────────────────
  await resetDb()
  console.log('1) 旧数据兼容')
  const active = activeLoansBySpecimen(await db.loans.toArray())
  check('sp_a 无借还记录 → 在库', custodyOf('sp_a', active) === '在库')
  check('sp_b 无借还记录 → 在库', custodyOf('sp_b', active) === '在库')

  // ── 2. 整批外借：登记 + 释放柜位 ────────────────────────────
  console.log('2) 整批外借')
  const created = await loanStore.getState().lendMany(['sp_a', 'sp_b'], lendInput)
  check('生成 2 条借出单', created.length === 2)
  check('借出单号按年流水', created[0].code === 'LOAN-2026-0001' && created[1].code === 'LOAN-2026-0002', `${created[0].code}, ${created[1].code}`)
  await hydrateAll()
  const loansAfterLend = await db.loans.toArray()
  check('库里恰好 2 条借还记录', loansAfterLend.length === 2)
  check('两份标本均为外借状态', loansAfterLend.every((l) => l.status === '外借'))
  const storagesAfterLend = await db.storages.toArray()
  check('原柜位记录已释放（仅剩 sp_c）', storagesAfterLend.length === 1 && storagesAfterLend[0].specimenId === 'sp_c')
  const active2 = activeLoansBySpecimen(loansAfterLend)
  check('派生保管状态：sp_a 外借', custodyOf('sp_a', active2) === '外借')
  const loanA = loansAfterLend.find((l) => l.specimenId === 'sp_a') as Loan
  check('原柜位快照保留 C01-D1-B01-S01', loanA.origin.cabinet === 'C01' && loanA.origin.drawer === 1 && loanA.origin.box === 1 && loanA.origin.slot === 1)
  check('原柜位记录 ID 保留（stg_a），用于幂等归还', loanA.origin.storageId === 'stg_a')
  check('借用人与期限已记录', loanA.borrower === '纪鸣' && loanA.dueDate === '2026-09-20')

  // ── 3. 外借期间不能重复借出 / 不能入柜 / 不能新增鉴定 ────────
  console.log('3) 外借期间的操作限制')
  let threw = false
  try {
    await loanStore.getState().lendMany(['sp_a'], lendInput)
  } catch {
    threw = true
  }
  check('外借标本不能再次借出', threw)
  check('拒绝后没有多出借还记录', (await db.loans.count()) === 2)
  check('拒绝后柜位仍只有 sp_c', (await db.storages.count()) === 1)

  threw = false
  try {
    await loanStore.getState().placeToStorage({
      id: 'stg_x', specimenId: 'sp_a', method: '针插', cabinet: 'C03', drawer: 1, box: 1, slot: 1,
      storedDate: '2026-09-05', handler: '覃羽'
    })
  } catch {
    threw = true
  }
  check('外借标本不能入柜', threw)
  check('入柜被拒后柜位数不变', (await db.storages.count()) === 1)

  threw = false
  try {
    await determinationStore.getState().save({
      id: 'det_x', specimenId: 'sp_a', determiner: '某人', date: '2026-09-05',
      conclusion: 'X sp.', reference: '', confidence: '高', needReview: false
    })
  } catch {
    threw = true
  }
  check('外借标本不能新增鉴定', threw)
  check('鉴定记录未产生', (await db.determinations.count()) === 0)

  // 待归位（已回馆）可以鉴定
  await hydrateAll()

  // ── 4. 归还：原柜位空着 → 放回原柜位并结清 ──────────────────
  console.log('4) 归还（原柜位空）')
  const result1 = await loanStore.getState().returnMany(['sp_a'], '覃羽')
  check('sp_a 放回原柜位', result1.restored.length === 1 && result1.pending.length === 0)
  const restoredA = await db.storages.where('specimenId').equals('sp_a').first()
  check('柜位记录按原 ID 与原位重建', !!restoredA && restoredA.id === 'stg_a' && restoredA.slot === 1 && restoredA.cabinet === 'C01')
  const loanANow = await db.loans.where('specimenId').equals('sp_a').first()
  check('借还记录结清为已归还、保留原柜位', loanANow?.status === '已归还' && loanANow.origin.slot === 1)
  await hydrateAll()
  const active4 = activeLoansBySpecimen(await db.loans.toArray())
  check('sp_a 重新派生为在库', custodyOf('sp_a', active4) === '在库')

  // 已归还再点归还：不多记录
  const result1b = await loanStore.getState().returnMany(['sp_a'], '覃羽')
  check('对已归还标本重复归还：幂等无操作', result1b.restored.length === 0 && result1b.pending.length === 0)
  check('借还记录仍是 2 条', (await db.loans.count()) === 2)
  // 此时 sp_b 仍外借（柜位未释放回归），故在柜记录为 sp_a + sp_c 共 2 条；关键是幂等前后数量不变
  check('幂等归还前后柜位记录数量不变（2 条）', (await db.storages.count()) === 2)

  // ── 5. 归还：原柜位被占 → 待归位区，不挤掉新标本 ────────────
  console.log('5) 归还（原柜位被占）')
  // 把新标本 sp_c 放进 sp_b 的原柜位 C01-D1-B01-S02
  await loanStore.getState().placeToStorage({
    id: 'stg_c2', specimenId: 'sp_c', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2,
    storedDate: '2026-09-10', handler: '覃羽'
  })
  // 上面 sp_c 原本有 stg_c（C02-...），placeToStorage 是新 id，会变成两条 —— 模拟占用时直接覆盖原 stg_c id
  await db.storages.delete('stg_c2')
  await db.storages.put({
    id: 'stg_c', specimenId: 'sp_c', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 2,
    storedDate: '2026-09-10', handler: '覃羽'
  } as Storage)
  await hydrateAll()
  const result2 = await loanStore.getState().returnMany(['sp_b'], '覃羽')
  check('sp_b 进入待归位区', result2.restored.length === 0 && result2.pending.length === 1)
  check('待归位结果带原柜位文本', result2.pending[0]?.originSlot === 'C01-D1-B01-S02')
  const loanBNow = await db.loans.where('specimenId').equals('sp_b').first()
  check('借还状态为待归位且保留原柜位', loanBNow?.status === '待归位' && loanBNow.origin.slot === 2)
  const occupant = await db.storages.where('specimenId').equals('sp_c').first()
  check('现有标本 sp_c 未被挤掉', !!occupant && occupant.cabinet === 'C01' && occupant.slot === 2)
  check('待归位期间没有 sp_b 的柜位记录', !(await db.storages.where('specimenId').equals('sp_b').first()))
  await hydrateAll()
  const active5 = activeLoansBySpecimen(await db.loans.toArray())
  check('sp_b 派生为待归位', custodyOf('sp_b', active5) === '待归位')

  // ── 6. 待归位重试：原柜位仍占 → 继续等待；空了 → 归位 ────────
  console.log('6) 待归位重试')
  const retry1 = await loanStore.getState().retryRestore(['sp_b'])
  check('原柜位仍占用：继续待归位，不新增记录', retry1.pending.length === 1 && retry1.restored.length === 0 && (await db.loans.count()) === 2)

  // sp_c 挪走，原柜位空出
  await db.storages.delete('stg_c')
  await hydrateAll()
  const retry2 = await loanStore.getState().retryRestore(['sp_b'])
  check('原柜位空出：归位成功', retry2.restored.length === 1 && retry2.pending.length === 0)
  const restoredB = await db.storages.where('specimenId').equals('sp_b').first()
  check('sp_b 回到原柜位、用回原记录 ID', !!restoredB && restoredB.id === 'stg_b' && restoredB.slot === 2)
  const loanBDone = await db.loans.where('specimenId').equals('sp_b').first()
  check('借还记录结清，仍是同一条（无重复）', loanBDone?.status === '已归还' && (await db.loans.count()) === 2)

  // ── 7. 待归位期间手工放到新柜位 → 借还记录自动结清 ───────────
  console.log('7) 待归位手工改放')
  await resetDb()
  await loanStore.getState().lendMany(['sp_a'], lendInput)
  // 制造原柜位占用
  await db.storages.put({
    id: 'stg_b', specimenId: 'sp_b', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1,
    storedDate: '2026-09-10', handler: '覃羽'
  } as Storage)
  await hydrateAll()
  const r = await loanStore.getState().returnMany(['sp_a'], '覃羽')
  check('sp_a 因原柜位占用进入待归位', r.pending.length === 1)
  // 手工拖到其他空插位（此时无 sp_a 柜位记录，给新 id）
  await loanStore.getState().placeToStorage({
    id: 'stg_a_new', specimenId: 'sp_a', method: '针插', cabinet: 'C09', drawer: 1, box: 1, slot: 9,
    storedDate: '2026-09-12', handler: '覃羽'
  })
  const loanA2 = await db.loans.where('specimenId').equals('sp_a').first()
  check('手工入柜后借还记录结清', loanA2?.status === '已归还')
  check('原柜位快照仍保留在记录上', loanA2?.origin.slot === 1)
  check('sp_a 在新柜位', (await db.storages.where('specimenId').equals('sp_a').first())?.cabinet === 'C09')
  await hydrateAll()
  check('派生状态恢复在库', custodyOf('sp_a', activeLoansBySpecimen(await db.loans.toArray())) === '在库')

  // 入柜冲突：不能覆盖现有标本
  let conflict = false
  try {
    await loanStore.getState().placeToStorage({
      id: 'stg_zzz', specimenId: 'sp_c', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1,
      storedDate: '2026-09-13', handler: '覃羽'
    })
  } catch {
    conflict = true
  }
  check('柜位冲突时拒绝入柜且不覆盖', conflict)
  check('原占用记录仍是 sp_b', (await db.storages.get('stg_b'))?.specimenId === 'sp_b')

  // ── 8. 写入失败事务回滚（人为在事务中途抛错）：整体恢复 ───────
  console.log('8) 事务回滚')
  await resetDb()
  const beforeStorages = (await db.storages.toArray()).map((s) => s.id).sort()
  const beforeLoans = await db.loans.count()
  let rolledBack = false
  try {
    await db.transaction('rw', db.storages, db.loans, async () => {
      await db.loans.put({
        id: 'loan_half', code: 'LOAN-2026-9999', specimenId: 'sp_a', borrower: 'X', organization: '',
        loanDate: '2026-09-01', dueDate: '2026-09-20', returnedDate: '', status: '外借',
        origin: { storageId: 'stg_a', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1 },
        handler: '', note: ''
      })
      await db.storages.delete('stg_a')
      throw new Error('模拟写入中断')
    })
  } catch {
    rolledBack = true
  }
  check('事务中途抛错被捕获', rolledBack)
  check('借还记录数量恢复（无半条）', (await db.loans.count()) === beforeLoans)
  const afterStorages = (await db.storages.toArray()).map((s) => s.id).sort()
  check('原柜位记录完整恢复', JSON.stringify(afterStorages) === JSON.stringify(beforeStorages))

  // ── 9. 同一份借出提交重试（确定性 ID）不多记录 ───────────────
  console.log('9) 重试幂等')
  await resetDb()
  const first = await loanStore.getState().lendMany(['sp_a'], lendInput)
  // 模拟同参数重试不会发生在正常 UI（已被 active 检查拦截）；直接验证：对同一标本同一天再借会被拒绝
  let dupBlocked = false
  try {
    await loanStore.getState().lendMany(['sp_a'], lendInput)
  } catch {
    dupBlocked = true
  }
  check('同标本重复借出被整单拒绝', dupBlocked)
  check('借还记录仍然只有 1 条', (await db.loans.count()) === 1)
  check('柜位仍然全部释放（2 条）', (await db.storages.count()) === 2)
  check('首单 ID 确定性', first[0]?.id === 'loan_sp_a_20260901')

  // 归还重试在「放回成功」场景同样幂等：storageId 复用
  await loanStore.getState().returnMany(['sp_a'], '覃羽')
  const storagesCount = await db.storages.count()
  await loanStore.getState().retryRestore(['sp_a']) // 已结清：无操作
  check('归位后再重试不产生记录', (await db.storages.count()) === storagesCount && (await db.loans.count()) === 1)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
