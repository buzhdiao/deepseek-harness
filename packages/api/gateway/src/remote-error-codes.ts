// 网关(Gateway)基础设施故障码：并入共享的 Remote 故障词汇表。对两个“面”保持中立：Host 面与 Client 面各自引入本模块，从而看到同一份映射条目。
/**
 * Gateway infrastructure failure codes merged into the shared Remote failure
 * vocabulary. Face-neutral: the Host face and the Client face each import this
 * module so both programs see the same map entries.
 */

/** Wire details every Gateway infrastructure failure carries. */
// 每个网关基础设施故障都会携带的线上(wire)明细字段。
export interface TypertGatewayFaultDetails {
  /** Canonical `<namespace>/<method>` endpoint. */
  // 规范的 `<namespace>/<method>` 端点(endpoint)。
  readonly endpoint: string
  /** Affected wire field when the failure is field-specific. */
  // 当故障针对某个具体字段时，受影响的线上字段名。
  readonly field?: string
}

// 模块扩充(module augmentation)：把下列网关故障码登记进共享协议库的 RemoteErrorDetailsMap，
// 让这些码在类型层面获得与上方一致、可跨线传输的明细结构。
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    // 以下 21 个 `gateway/*` 故障码全部复用同一种明细类型 TypertGatewayFaultDetails（纯登记项，无独立逻辑）。
    'gateway/ambiguous-endpoint': TypertGatewayFaultDetails
    'gateway/arguments-invalid': TypertGatewayFaultDetails
    'gateway/binding-invalid': TypertGatewayFaultDetails
    'gateway/context-failed': TypertGatewayFaultDetails
    'gateway/context-not-found': TypertGatewayFaultDetails
    'gateway/context-unavailable': TypertGatewayFaultDetails
    'gateway/definition-unavailable': TypertGatewayFaultDetails
    'gateway/input-invalid': TypertGatewayFaultDetails
    'gateway/interactions-forbidden': TypertGatewayFaultDetails
    'gateway/invocation-unavailable': TypertGatewayFaultDetails
    'gateway/lookup-failed': TypertGatewayFaultDetails
    'gateway/lookup-not-found': TypertGatewayFaultDetails
    'gateway/lookup-unavailable': TypertGatewayFaultDetails
    'gateway/method-unavailable': TypertGatewayFaultDetails
    'gateway/peer-disposed': TypertGatewayFaultDetails
    'gateway/protocol': TypertGatewayFaultDetails
    'gateway/provider-mismatch': TypertGatewayFaultDetails
    'gateway/result-invalid': TypertGatewayFaultDetails
    'gateway/service-unavailable': TypertGatewayFaultDetails
    'gateway/signature-invalid': TypertGatewayFaultDetails
    'gateway/uplink-overflow': TypertGatewayFaultDetails
  }
}
