import RFB from '@novnc/novnc';

const screen = document.querySelector<HTMLDivElement>('#screen')!;
const status = document.querySelector<HTMLSpanElement>('#status')!;
const reconnect = document.querySelector<HTMLButtonElement>('#reconnect')!;
const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
const capability = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
let current: RFB | undefined;

function connect() {
  if (!capability || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    status.textContent = 'Open the desktop again from the CLI.';
    reconnect.disabled = true;
    return;
  }
  current?.disconnect();
  screen.replaceChildren();
  status.textContent = 'Connecting…';
  reconnect.disabled = true;
  const rfb = new RFB(screen, `ws://${location.host}/desktop`, {
    wsProtocols: ['mvm-desktop', `mvm-desktop.auth.${capability}`],
    shared: true,
  });
  current = rfb;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener('connect', () => {
    if (current !== rfb) return;
    status.textContent = 'Connected';
    reconnect.disabled = false;
  });
  rfb.addEventListener('disconnect', () => {
    if (current !== rfb) return;
    status.textContent = 'Disconnected. Reconnect while the CLI is running.';
    reconnect.disabled = false;
  });
  rfb.addEventListener('securityfailure', () => {
    if (current === rfb) status.textContent = 'The desktop connection was refused.';
  });
}

reconnect.addEventListener('click', connect);
fullscreen.addEventListener('click', () => {
  void (document.fullscreenElement ? document.exitFullscreen() : screen.requestFullscreen()).catch(() => {});
});
connect();
