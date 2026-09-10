export type NodeRole = 'main' | 'child'
export type NodeConnection = 'connected' | 'connecting' | 'offline'
export type CapabilityAvailability = 'online' | 'unavailable' | 'revoked'

export interface WorkdirCapabilityFixture {
  capabilityId: string
  displayName: string
  displayPath: string
  permissions: string[]
  approvalPolicy: 'always' | 'session' | 'grant'
  availability: CapabilityAvailability
  unavailableReason?: string
}

export interface ProductNodeFixture {
  nodeId: string
  displayName: string
  role: NodeRole
  connection: NodeConnection
  version: string
  lastSeen: string
  isLocal: boolean
  capabilities: WorkdirCapabilityFixture[]
}

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
  nodes: ProductNodeFixture[]
  approvals: ApprovalRequestFixture[]
}

export const DEFAULT_PRODUCT_FIXTURES: ProductFixturesV1 = {
  version: 1,
  nodes: [
    {
      nodeId: 'main-studio',
      displayName: 'Studio Main',
      role: 'main',
      connection: 'connected',
      version: '0.1.0-dev',
      lastSeen: 'Now',
      isLocal: true,
      capabilities: [
        {
          capabilityId: 'cap-shadow-source',
          displayName: 'Shadow source',
          displayPath: 'C:\\Users\\ci010-4090\\Workspace\\windows-use',
          permissions: ['read', 'write', 'shell'],
          approvalPolicy: 'session',
          availability: 'online',
        },
        {
          capabilityId: 'cap-session-artifacts',
          displayName: 'Main-owned session artifacts',
          displayPath: 'C:\\ProgramData\\Shadow\\sessions\\retained-artifacts',
          permissions: ['read'],
          approvalPolicy: 'grant',
          availability: 'online',
        },
      ],
    },
    {
      nodeId: 'child-render-01',
      displayName: 'Render workstation with a deliberately long device name',
      role: 'child',
      connection: 'connecting',
      version: '0.1.0-dev',
      lastSeen: '18 seconds ago',
      isLocal: false,
      capabilities: [
        {
          capabilityId: 'cap-production-assets',
          displayName: 'Production assets and scene exports',
          displayPath: 'D:\\Production\\Client Deliverables\\2026\\August\\Extremely Long Project Name That Must Wrap\\source-and-render-assets',
          permissions: ['read', 'write', 'shell', 'gpu'],
          approvalPolicy: 'always',
          availability: 'unavailable',
          unavailableReason: 'Node connection is still being established.',
        },
      ],
    },
    {
      nodeId: 'child-field-archive',
      displayName: 'Field archive',
      role: 'child',
      connection: 'offline',
      version: '0.0.9',
      lastSeen: '3 days ago',
      isLocal: false,
      capabilities: [
        {
          capabilityId: 'cap-field-notes',
          displayName: 'Field notes archive',
          displayPath: '/srv/archive/field-notes/long-running-research-program/raw-material',
          permissions: ['read'],
          approvalPolicy: 'grant',
          availability: 'revoked',
          unavailableReason: 'The capability grant was revoked on this Child.',
        },
      ],
    },
  ],
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