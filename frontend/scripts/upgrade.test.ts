import 'fake-indexeddb/auto'
import Dexie, { type Table } from 'dexie'

let passed = 0
let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.error(`  ✗ ${name}`) }
}

/** 用 v2 结构建一个「旧库」（与升级前的 schema 完全一致） */
class OldDb extends Dexie {
  specimens!: Table<unknown, string>
  sites!: Table<unknown, string>
  storages!: Table<unknown, string>
  determinations!: Table<unknown, string>
  meta!: Table<{ key: string; value: number }, string>
  constructor() {
    super('gbinsectlog')
    this.version(1).stores({
      specimens: 'id, code, order, status, siteId',
      sites: 'id, code, name',
      storages: 'id, specimenId, cabinet',
      determinations: 'id, specimenId, determiner',
      meta: 'key'
    })
    this.version(2).stores({
      specimens: 'id, code, order, family, status, siteId, collectDate',
      sites: 'id, code, name, habitat',
      storages: 'id, specimenId, cabinet, drawer',
      determinations: 'id, specimenId, determiner, date',
      meta: 'key'
    })
  }
}

async function main(): Promise<void> {
  console.log('v2 → v3 升级兼容')
  const today = '2026-08-01'
  const old = new OldDb()
  await old.specimens.bulkPut([
    { id: 'sp_1', code: 'QLB-2026-0001', order: '鞘翅目', family: '步甲科', genus: '', species: '',
      tempName: '步甲', collectDate: today, collector: '陆昀', sex: '雄', stage: '成虫', bodyLength: 20,
      method: '徒手', quantity: 1, status: '初鉴', determiner: '', siteId: 's1', note: '' }
  ])
  await old.sites.put({
    id: 's1', code: 'QLB', name: '青龙背', region: '黔南', longitude: 107.2, latitude: 25.8,
    altitude: 900, habitat: '阔叶林', microHabitat: '', microClimate: '', dateStart: today, dateEnd: today
  })
  await old.storages.put({
    id: 'stg_1', specimenId: 'sp_1', method: '针插', cabinet: 'C01', drawer: 1, box: 1, slot: 1,
    storedDate: today, handler: '覃羽'
  })
  await old.meta.put({ key: 'schemaVersion', value: 2 })
  old.close()

  // 用当前代码重新打开同名库，应自动升级到 v3
  const { db } = await import('@/hooks/usePersistentStore')
  const { activeLoansBySpecimen, custodyOf } = await import('@/utils/custody')
  db.verno; check('旧库顺利打开（v3 迁移完成）', (await db.specimens.count()) >= 0)
  check('loans 表存在', db.tables.some((t) => t.name === 'loans'))
  check('旧标本完整保留', (await db.specimens.count()) === 1)
  check('旧柜位记录完整保留', (await db.storages.count()) === 1)
  check('借还记录为空（旧数据）', (await db.loans.count()) === 0)
  const loans = await db.loans.toArray()
  const active = activeLoansBySpecimen(loans)
  check('无借还记录的旧标本派生为在库', custodyOf('sp_1', active) === '在库')
  const meta = await db.meta.get('schemaVersion')
  check('已升级到 schemaVersion 3', db.verno === 3); check('版本号仍可读写', typeof meta?.value === 'number')

  // 升级后能正常做一笔借出
  const { loanStore } = await import('@/stores/loanStore')
  await db.specimens.toArray()
  await loanStore.getState().hydrate()
  const created = await loanStore.getState().lendMany(['sp_1'], {
    borrower: '纪鸣', organization: '林科院', loanDate: '2026-09-01', dueDate: '2026-09-20', handler: '覃羽', note: ''
  })
  check('升级后的库可正常借出', created.length === 1)
  check('借出后原柜位释放', (await db.storages.count()) === 0)

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
