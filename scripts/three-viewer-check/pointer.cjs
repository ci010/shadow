// Use Chromium's input dispatcher so pointer capture and trusted events are
// exercised even when another macOS app has foreground window focus.
module.exports = function browserPointer(contents) {
  contents.debugger.attach('1.3');
  let buttons = 0;
  return async (kind, x, y, button = 'left') => {
    if (kind === 'wheel') {
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: button });
      return;
    }
    const mask = button === 'right' ? 2 : 1;
    if (kind === 'down') buttons |= mask;
    if (kind === 'up') buttons &= ~mask;
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[kind],
      x, y, button: kind === 'move' ? 'none' : button, buttons,
      ...(kind === 'move' ? {} : { clickCount: 1 }),
    });
  };
};
