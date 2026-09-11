export interface ApprovalRequestFixture {
  requestId: string
  ownerNodeId: string
  requester: {
    agentName: string
    sessionId: string
    sessionLabel: string
  }
  operation: {
    kind: 'shell' | 'filesystem'
    summary: string
    details: Array<{ label: string; value: string }>
  }
  scope: {
    nodeId: string
    workdirCapabilityId: string
    displayPath: string
  }
  expiresIn: string
  status: 'pending' | 'expired'
}

export interface ProductFixturesV1 {
  version: 1
  approvals: ApprovalRequestFixture[]
}

export const DEFAULT_PRODUCT_FIXTURES: ProductFixturesV1 = {
  version: 1,
  approvals: [
    {
      requestId: 'approval-render-export-01',
      ownerNodeId: 'child-render-01',
      requester: {
        agentName: 'render-coordinator',
        sessionId: 'session-august-delivery',
        sessionLabel: 'August delivery review',
      },
      operation: {
        kind: 'shell',
        summary: 'Run the signed render export task in the production workspace.',
        details: [
          { label: 'Executable', value: 'pnpm export:review' },
          { label: 'Access', value: 'Read source assets and write review exports' },
        ],
      },
      scope: {
        nodeId: 'child-render-01',
        workdirCapabilityId: 'cap-production-assets',
        displayPath: 'D:\\Production\\Client Deliverables\\2026\\August\\Extremely Long Project Name That Must Wrap\\source-and-render-assets',
      },
      expiresIn: '4 minutes',
      status: 'pending',
    },
    {
      requestId: 'approval-render-manifest-02',
      ownerNodeId: 'child-render-01',
      requester: {
        agentName: 'asset-indexer-with-a-deliberately-long-name',
        sessionId: 'session-manifest-refresh',
        sessionLabel: 'Production manifest refresh',
      },
      operation: {
        kind: 'filesystem',
        summary: 'Write a refreshed asset manifest beside the source files.',
        details: [
          { label: 'Write target', value: '.shadow/manifests/production-assets.json' },
          { label: 'Access', value: 'Read tree metadata and write one manifest file' },
        ],
      },
      scope: {
        nodeId: 'child-render-01',
        workdirCapabilityId: 'cap-production-assets',
        displayPath: 'D:\\Production\\Client Deliverables\\2026\\August\\Extremely Long Project Name That Must Wrap\\source-and-render-assets',
      },
      expiresIn: '9 minutes',
      status: 'pending',
    },
  ],
}