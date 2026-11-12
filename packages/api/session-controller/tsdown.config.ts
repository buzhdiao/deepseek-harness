// 模块说明：本包（api session-controller）的 tsdown 打包配置：复用客户端共享的
// clientBundle 工厂，以 lib/types/index.js 为类型入口，hostPhase 阶段参与宿主打包。

// 导入客户端包共享的 tsdown 打包配置工厂（clientBundle），用于按客户端环境打包本包
import { clientBundle } from '../../client/tsdown.client.ts'

// 导出打包配置：以当前目录为入口包目录进行 clientBundle 配置
export default clientBundle(
  // import.meta.dirname：本配置文件所在目录，即包根目录
  import.meta.dirname,
  // 入口文件列表：类型定义入口（lib/types/index.js）
  ['lib/types/index.js'],
  // 额外选项：hostPhase 为 true 表示在宿主（host）阶段参与打包
  { hostPhase: true },
)
