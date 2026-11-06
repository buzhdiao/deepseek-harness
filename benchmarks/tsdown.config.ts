import { defineConfig } from 'tsdown'

// 各构建条目共享的基准配置。
const shared = {
  // 输出 ESM 格式。
  format: 'esm' as const,
  // 面向 Node 平台。
  platform: 'node' as const,
  // 语法目标为 ES2024。
  target: 'es2024',
  // 不强制统一 .js 扩展名。
  fixedExtension: false,
  // 不生成类型声明（dts）。
  dts: false,
  // 依赖打包策略。
  deps: {
    // 永不打包工作区包（@deepseek-ai/*）：保持其对外的 lib 构建入口。
    neverBundle: [/^@deepseek-ai\//],
    // 不启用白名单式打包。
    onlyBundle: false as const,
  },
}

/** Compile measured benchmark workers while keeping workspace packages on their built `lib` entries. */
// 导出每个被测基准 worker 的构建配置数组（每条一个输出目录）。
export default defineConfig([
  // 构建 terminal-io worker（宿主侧 tsconfig）。
  {
    ...shared,
    entry: { 'terminal-io.worker': 'terminal-io/terminal-io.worker.ts' },
    outDir: '.dsh-build/terminal-io',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  // 构建活跃流重连 worker（客户端侧 tsconfig）。
  {
    ...shared,
    entry: { 'reconnect.worker': 'active-stream-reconnect/reconnect.worker.client.ts' },
    outDir: '.dsh-build/active-stream-reconnect',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  // 构建 Agent 续跑相关 worker 与配置适配器（宿主侧 tsconfig）。
  {
    ...shared,
    entry: {
      'agent-continuation.worker': 'agent-continuation/agent-continuation.worker.ts',
      'child-catalog.worker': 'agent-continuation/child-catalog.worker.ts',
      'profile-continuation.worker': 'agent-continuation/profile-continuation.worker.ts',
      'profile-adapter': 'agent-continuation/profile-adapter.ts',
    },
    outDir: '.dsh-build/agent-continuation',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  // 构建会话打开 worker（宿主侧 tsconfig）。
  {
    ...shared,
    entry: { 'session-open.worker': 'session-open/session-open.worker.ts' },
    outDir: '.dsh-build/session-open',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  // 构建会话语料与投影列表 worker（宿主侧 tsconfig）。
  {
    ...shared,
    entry: {
      'session-corpus.worker': 'session-corpus/session-corpus.worker.ts',
      'projection-list.worker': 'session-corpus/projection-list.worker.ts',
    },
    outDir: '.dsh-build/session-corpus',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
  // 构建会话折叠 worker（客户端侧 tsconfig）。
  {
    ...shared,
    entry: {
      'conversation-fold.worker': 'conversation-fold/conversation-fold.worker.client.ts',
    },
    outDir: '.dsh-build/conversation-fold',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
  // 构建用户文本 worker（客户端侧 tsconfig）。
  {
    ...shared,
    entry: { 'user-text.worker': 'user-text/user-text.worker.client.ts' },
    outDir: '.dsh-build/user-text',
    clean: true,
    tsconfig: 'tsconfig.client.json',
  },
])
