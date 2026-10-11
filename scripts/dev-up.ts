/**
 * 职责：本地一键启动的 CLI 入口（F17 单元①）——只做「读参数 → 装配步骤 → 执行 → 打印」。
 *      所有可被测试的逻辑都在 dev-up-lib.ts；本文件刻意薄到「没有值得测的东西」。
 *
 * 用法：
 *   npm run dev                  # .env（缺则物化）→ 建库（缺则创建）→ 迁移 → 灌 demo（仅当库是空的）→ 起服务
 *   npm run dev -- --full        # 灌完整商品目录
 *   npm run dev -- --no-seed     # 不灌数据
 *   npm run dev -- --reseed      # 清空业务表后重灌（库里已有数据时默认**不**灌；有真订单会被内容闸门拒绝）
 *   npm run dev -- --no-serve    # 只准备环境，不起服务
 *
 * @why 起服务**在进程内**调 `bootstrap()`：信号处理（SIGINT/SIGTERM → 优雅停机）复用
 *      server 已测过的那条路径（installShutdownHandlers + signal-harness），
 *      不引入「spawn 子进程 + 信号转发」这条没人测过的新路径。代价是没有 watch 模式，
 *      见 dev-up-lib.ts @limitation 一。
 *
 * @see scripts/dev-up-lib.ts（全部逻辑与理由）；scripts/seed-lib.ts（闸门与灌数据）
 */
import { attachDevImages } from './dev-images-lib.js';
import { createFsStorage } from '../server/src/adapters/storage-fs.js';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, createDb } from '../server/src/adapters/db.js';
import { bootstrap } from '../server/src/main.js';
import {
  DevUpStepError,
  devLinkHints,
  ensureDatabase,
  ensureDevFxStep,
  ensureEnvFile,
  localOsRole,
  migrateUp,
  parseDevUpArgs,
  runSteps,
  seedStep,
  type DevUpStep,
} from './dev-up-lib.js';
import { defaultDevUrl } from './seed-lib.js';
import { API_BASES } from '../miniprogram/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function out(s: string): void {
  process.stdout.write(`[dev] ${s}\n`);
}

async function main(): Promise<void> {
  const opts = parseDevUpArgs(process.argv.slice(2));

  // ① .env：缺则从 .env.example 物化（生成 JWT_SECRET、替换 <user>）；已有一个字不动
  const envRes = ensureEnvFile(root, {
    dbUser: localOsRole(),
    jwtSecret: randomBytes(32).toString('hex'),
  });
  if (envRes.status === 'created') {
    out('已从 .env.example 生成 .env（JWT_SECRET 已随机生成；其余占位按需自行填写）');
  }
  if (existsSync(envRes.path)) process.loadEnvFile(envRes.path); // 已存在的环境变量优先，不覆盖

  // ② 库连接串：环境变量 > .env > 本机 dev 库推导；推导值也写回 env——
  //    否则「迁移/灌数据用的库」与「bootstrap 里 loadConfig 读的库」会是两个（D29 类幽灵差异）
  const databaseUrl = process.env.DATABASE_URL ?? defaultDevUrl();
  process.env.DATABASE_URL ??= databaseUrl;

  const steps: DevUpStep[] = [
    {
      name: '数据库可达',
      hint: '本机 Postgres 是否在运行？（brew services start postgresql@16）；库不存在会自动创建',
      run: async () => {
        const r = await ensureDatabase(databaseUrl);
        return r === 'created'
          ? `已创建 ${new URL(databaseUrl).pathname.slice(1)}`
          : '数据库已存在';
      },
    },
    {
      name: '迁移到最新',
      hint: '单独跑 npm run db:migrate 看完整输出',
      run: async () => {
        await migrateUp({ root, databaseUrl });
        return '迁移完成';
      },
    },
  ];

  if (opts.seed) {
    steps.push({
      name: '灌假数据',
      hint: '单独跑 npm run db:seed 看完整输出；加 --full 灌完整目录；加 --reseed 清空重灌',
      run: async () => {
        const db = createDb({ url: databaseUrl, max: 2 });
        try {
          // 已有数据就跳过；只有 --reseed 才清空重灌（AJ-242，逻辑与理由在 dev-up-lib.ts 的 seedStep）
          return await seedStep(db, { full: opts.full, reseed: opts.reseed });
        } finally {
          await closeDb(db);
        }
      },
    });
  }

  // 开发汇率：没有或已过期就补一条（本地演练实测：开发库汇率过 72 小时整店报价 50003）
  steps.push({
    name: '开发汇率',
    hint: '也可在管理端「运营配置」里手动录入汇率',
    run: async () => {
      const db = createDb({ url: databaseUrl, max: 1 });
      try {
        const maxAge = Number(process.env.FX_MAX_AGE_HOURS ?? 72);
        const buf = Number(process.env.FX_BUFFER_RATE ?? 0.03);
        return await ensureDevFxStep(
          db,
          Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 72,
          Number.isFinite(buf) && buf >= 0 ? buf : 0.03,
        );
      } finally {
        await closeDb(db);
      }
    },
  });

  // 开发商品图（三端联动模拟 2026-10-08）：种子商品没有图，页面上只有占位图。只在本地盘存储时做。
  const driver = process.env.STORAGE_DRIVER ?? '';
  if (driver === '' || driver === 'fs') {
    steps.push({
      name: '开发商品图',
      hint: '单独跑 npm run dev:images；图片经 /dev-img 提供，需 IMG_BASE_URL=http://localhost:3000/dev-img',
      run: async () => {
        const db = createDb({ url: databaseUrl, max: 1 });
        try {
          const n = await attachDevImages(
            db,
            createFsStorage(process.env.STORAGE_FS_DIR ?? './var/uploads'),
          );
          return n === 0 ? '商品都已有图' : `已为 ${String(n)} 件商品生成图片`;
        } finally {
          await closeDb(db);
        }
      },
    });
  }

  if (opts.serve) {
    steps.push({
      name: '起服务',
      hint: '单独起：npx tsx server/src/main.ts；配置问题会逐行列出（ConfigError）',
      run: async () => {
        const runtime = await bootstrap();
        // E-7：两种"静默卡住"在启动这一刻说出来（模拟付款到不了已付款 / 小程序连错端口）
        for (const h of devLinkHints(runtime.config, API_BASES.develop)) out(`⚠️ ${h}`);
        return `listening on http://${runtime.config.HOST}:${runtime.config.PORT}（Ctrl+C 优雅停机）`;
      },
    });
  }

  await runSteps(steps, { onStepDone: (name, summary) => out(`✓ ${name}：${summary}`) });
}

main().catch((err: unknown) => {
  if (err instanceof DevUpStepError) {
    process.stderr.write(`[dev] ${err.message}\n`);
    if (err.completed.length > 0) {
      process.stderr.write(`[dev] 已完成：${err.completed.join(' → ')}\n`);
    }
    process.stderr.write(`[dev] 怎么办：${err.hint}\n`);
    // 多行细节（如迁移的 PG 错误原文）完整打印：head 单行是为了终端，细节是给人排查的
    if (err.cause instanceof Error && err.cause.message.includes('\n')) {
      process.stderr.write(`${err.cause.message}\n`);
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dev] 失败：${message.replace(/[\r\n]+/g, ' ')}\n`);
  }
  process.exitCode = 1;
});
