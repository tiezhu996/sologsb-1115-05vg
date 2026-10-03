# 昆虫标本采集记录台（gbinsectlog）

面向野外昆虫调查队与标本馆技术员，把「标本采集 → 采集地与生境 → 鉴定状态 → 保藏位置」串成一条可追溯的编目链路，解决采集标签手写易错、鉴定进度无人跟踪、标本入柜后找不到位置的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21815>

常用命令：

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地，不受影响）
```

端口与项目名可在 `.env` 中调整：

```
COMPOSE_PROJECT_NAME=gbinsectlog
FRONTEND_PORT=21815
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 |
| 语言 | TypeScript（`tsc --noEmit` 类型检查零错误） |
| 样式 | Tailwind CSS 3 |
| 状态管理 | Zustand |
| 路由 | React Router 6（nginx `try_files` 回落，支持直接刷新子路由） |
| 构建 | Vite 5 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |
| 逻辑验证 | `npm test`：fake-indexeddb + esbuild 跑借还/事务/幂等端到端用例（50 项） |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21815
npm run build      # 类型检查 + 生产构建
```

> 本地开发无需任何后端服务或环境变量。

## 四、目录结构

```
sologsb-1115/
├── docker-compose.yml          # 顶层 name: gbinsectlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── tailwind.config.js / postcss.config.js
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # specimen.ts / site.ts / storage.ts / determination.ts / loan.ts / index.ts
│       ├── stores/             # specimenStore / siteStore / storageStore / determinationStore / loanStore（Zustand）
│       ├── components/common/  # SpecimenCard / StatusTag / CustodyTag / CabinetGrid / SitePicker
│       ├── hooks/              # usePersistentStore / useSpecimenFilter
│       ├── pages/              # SpecimensPage / SitesPage / CollectPage / DeterminationPage / StoragePage
│       ├── router/index.tsx
│       ├── scripts/            # loan.test.ts 借还端到端用例（npm test）
│       └── utils/              # codec.ts / custody.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Specimen 标本 | 编号、目/科/属/种、暂定名、采集日期与人、性别虫态、体长、采集方式、数量、鉴定状态 | `specimens` |
| CollectSite 采集地 | 代码、名称、行政区、经纬度海拔、生境类型、小生境、微气候、采集日期区间 | `sites` |
| Storage 保藏位置 | 保藏方式、柜/抽屉/盒/插位序号、入柜日期、经手人 | `storages` |
| Determination 鉴定记录 | 鉴定人、日期、结论（学名）、依据文献、置信度、是否需复核 | `determinations` |
| Loan 借还记录 | 借出单号、借用人/单位、借出与应还日期、归还登记日、状态（外借/待归位/已归还）、**原柜位快照**、经手人 | `loans` |

- 数据库名 `gbinsectlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史标本补齐默认采集方式（扫网）；
- `version(3)` 新增借还记录表；**历史标本没有借还记录，保管状态一律按「在库」兼容处理**，无需数据补齐；
- 标本编号规则：`采集地代码-年份-流水号`（如 `QLB-2026-0007`），提交时自动分配并查重；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/specimens` | 标本清单：按目/科、鉴定状态、采集地、采集日期区间与关键字组合筛选，多选批量推进鉴定状态，导出命中清单 |
| `/collect` | 采集登记：选择采集地后自动带出生境/小生境/微气候，一次提交多条同批次标本，编号自动生成并查重 |
| `/sites` | 采集地管理：经纬度格式校验、各地采集次数统计、50 米内邻近采集地提示与一键合并 |
| `/determination` | 鉴定工作流：待鉴定队列逐条处理，落鉴定记录并自动推进标本状态（已鉴定 / 待复核） |
| `/storage` | 保藏柜位图：柜-抽屉-盒-位三级展开，空位/占用一目了然，拖拽入柜，重复占用给出占用提示；在柜标本可整批勾选外借，外借清单批量归还，待归位区一键重试回原柜位 |

## 七、业务约定

- 采集地代码是标本编号前缀，代码重复会被拒绝；
- 坐标 50 米内视为同一采集地，页面上给出合并提示，合并会把原采集地标本自动改挂；
- 鉴定记录提交后自动把标本状态推进为「已鉴定」，勾选「需复核」则置为「待复核」；
- 同一柜位（柜-屉-盒-位）只允许一份标本，冲突时列出已有标本编号。

### 借还（v3 起）

- **整批外借**：柜位图勾选多份在柜标本 → 登记借用人、借用单位、借出日期与归还期限；借还记录保存**原柜位快照**（柜位与原 `storages` 记录 ID），随后在同一事务里释放柜位。
- **保管状态派生**：以借还记录为准，三态为「在库 / 外借 / 待归位」；柜位图、标本清单（卡片、筛选、导出）、鉴定页（队列、按钮、记录表）共用同一派生口径（`utils/custody.ts`），无借还记录的旧数据按在库显示。
- **外借冻结**：外借期间标本不能入柜/换柜、不能重复借出、不能新增鉴定（页面按钮禁用 + store 事务内再拦截）；鉴定状态批量推进也会拒绝外借标本。
- **归还**：原柜位空着 → 按快照和原记录 ID 放回原位并结清借还单；原柜位已被新标本占用 → 不挤掉现有标本，标本进入**待归位区**并保留原柜位信息，可「试回原柜位」或手工拖到其他空插位（拖入即结清）。
- **失败安全**：借出、归还、归位、入柜都在单个 Dexie 跨表事务（`storages + loans + specimens`）内完成，写入失败整体回滚——原柜位、借出状态、待归还清单恢复事务前状态，内存镜像随后以数据库重水合；借还记录 ID 与柜位记录 ID 均确定性复用，**重试不会多出记录**。
- 外借清单显示借用人、期限、单号与原柜位，超过应还日期标红「已逾期」。
