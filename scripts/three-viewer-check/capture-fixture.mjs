import { Bus } from '../../src/bus/bus.ts';
import { WebChannel } from '../../src/channels/web.ts';
import { GltfCaptureBridge } from '../../src/gateway/gltf-capture.ts';
import { CaptureViewTool } from '../../src/tools/capture-view.ts';
import { WriteTool } from '../../src/tools/filesystem.ts';
import { transientToolSummary } from '../../src/tools/tool.ts';
import { join } from 'node:path';
import { projectId, sessionId } from './constants.mjs';

// Real host bridge, Web admission and tools. Only the identity, session and
// execution loop are fixture substitutes; they have no production credentials.
export async function mountFixtureTools(app, workspace, fixtureScene) {
  const owner = new AbortController();
  const localOwner = request => request.headers.get('x-three-check-owner') === 'fixture' ? owner.signal : undefined;
  const bridge = new GltfCaptureBridge(projectId, localOwner, id => id === sessionId);
  bridge.mount(app);
  const channel = new WebChannel(new Bus(), { workspace, authorize: request => !!localOwner(request) });
  const chatId = sessionId.slice('web:'.length);
  const admitted = new Map();
  channel.setReceiver(async message => {
    if (message.chatId !== chatId || !message.content.includes('stand.rear.left') || !message.content.includes('stand.rear.right')) {
      throw new Error('Unexpected fixture chat or missing drafted rear-claw references');
    }
    await bridge.admitWebInput(message);
    admitted.set(message.messageId, message);
    return { status: 'accepted', sessionId, inputId: message.messageId };
  });
  await channel.start(app);
  const capture = new CaptureViewTool(projectId, bridge);
  const write = new WriteTool(fixtureScene, true);
  app.post('/test/tool/:name', async c => {
    const { messageId, args } = await c.req.json();
    const message = admitted.get(messageId);
    if (!localOwner(c.req.raw) || !message) return c.json({ error: 'No admitted fixture turn' }, 403);
    const context = {
      projectId, sessionId, messageId, chatId, physicalSessionId: 'fixture', channel: 'web',
      senderId: message.senderId, inputSource: 'user', admin: message.admin, workUserInput: message.content,
      signal: c.req.raw.signal,
    };
    if (c.req.param('name') === capture.name && ['current', 'front'].includes(args.mode)) {
      const result = await capture.execute(args, context);
      if (typeof result === 'string') return c.json({ error: result });
      return c.json({ content: result.content, transient: transientToolSummary(result) });
    }
    if (c.req.param('name') === write.name && typeof args.match === 'string' && typeof args.content === 'string') {
      const result = await write.execute({ path: join(fixtureScene, 'stand.mjs'), match: args.match, content: args.content }, context);
      return c.json({ receipt: result });
    }
    return c.json({ error: 'Unexpected fixture tool' }, 404);
  });
  return async () => { owner.abort(); bridge.close(); await channel.stop(); };
}
