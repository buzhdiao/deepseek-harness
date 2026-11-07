// 引入共享的客户端打包配置工厂 clientBundle（基于 tsdown 的统一打包辅助）。
import { clientBundle } from '../../client/tsdown.client.ts'

// 导出默认打包配置：以当前包目录为打包根，仅打包类型入口 lib/types/index.js，
// 并通过 hostPhase 标记该产物属于宿主（Host）阶段构建。
export default clientBundle(
  // 打包根目录：取当前模块所在包的目录。
  import.meta.dirname,
  // 打包入口列表：只有类型聚合入口一个文件。
  ['lib/types/index.js'],
  // 额外选项：hostPhase: true 表示按宿主阶段的规则生成产物。
  { hostPhase: true },
)
