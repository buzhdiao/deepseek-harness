// 引入共享的客户端(client)打包配置工厂，所有面向浏览器端的包都用它产出一致的构建产物。
import { clientBundle } from '../../client/tsdown.client.ts'

// 以本包目录为根构建客户端产物，并把 `lib/types/index.js` 也作为双端(dualClient)入口一并打包。
export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { dualClient: true })
