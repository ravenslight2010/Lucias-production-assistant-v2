import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || ('standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true);
}

function installInstructions() {
  const userAgent = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    return 'In Safari, tap Share, then choose Add to Home Screen.';
  }
  if (/Android/.test(userAgent)) {
    return 'Open your browser menu and choose Install app or Add to Home screen.';
  }
  return 'Open your browser menu and choose Install Lucia or Install page as app.';
}

export function PwaControls() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => typeof window !== 'undefined' && isAppInstalled());
  const [hasWaitingUpdate, setHasWaitingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadAfterActivationRef = useRef(false);
  const reloadAfterConfirmedUpdate = () => {
    if (!reloadAfterActivationRef.current) return;
    reloadAfterActivationRef.current = false;
    window.location.reload();
  };

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    const onDisplayModeChange = () => setInstalled(isAppInstalled());
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    const displayMode = window.matchMedia('(display-mode: standalone)');
    displayMode.addEventListener('change', onDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      displayMode.removeEventListener('change', onDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;

    const showWaitingWorker = () => {
      if (!disposed && registration?.waiting) setHasWaitingUpdate(true);
    };
    const watchInstallingWorker = () => {
      const installing = registration?.installing;
      if (!installing) return;
      installing.addEventListener('statechange', showWaitingWorker);
      showWaitingWorker();
    };
    const updateWorker = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
    };
    navigator.serviceWorker.addEventListener('controllerchange', reloadAfterConfirmedUpdate);
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: 'none',
    }).then((nextRegistration) => {
      if (disposed) return;
      registration = nextRegistration;
      registrationRef.current = nextRegistration;
      showWaitingWorker();
      registration.addEventListener('updatefound', watchInstallingWorker);
      updateWorker();
      document.addEventListener('visibilitychange', updateWorker);
    }).catch((error: unknown) => {
      console.warn('Lucia app updates could not be checked.', error);
    });
    const interval = window.setInterval(() => {
      if (registration) void registration.update().catch(() => {});
    }, 60 * 60 * 1000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', updateWorker);
      navigator.serviceWorker.removeEventListener('controllerchange', reloadAfterConfirmedUpdate);
      registration?.removeEventListener('updatefound', watchInstallingWorker);
      registrationRef.current = null;
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const applyUpdate = () => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      setHasWaitingUpdate(false);
      return;
    }
    setUpdating(true);
    reloadAfterActivationRef.current = true;
    waitingWorker.addEventListener('statechange', () => {
      if (waitingWorker.state === 'activated') {
        reloadAfterConfirmedUpdate();
      } else if (waitingWorker.state === 'redundant') {
        reloadAfterActivationRef.current = false;
        setUpdating(false);
        setHasWaitingUpdate(false);
      }
    });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  };

  if (import.meta.env.DEV || (installed && !hasWaitingUpdate)) return null;

  return (
    <aside className="pwa-controls" data-testid="pwa-controls" aria-label="App installation and updates">
      {!installed && (
        <section className="pwa-controls-section" aria-label="Install Lucia">
          {installPrompt ? (
            <button className="button button-primary pwa-install-button" type="button" onClick={() => void install()} data-testid="button-install-app">
              <Download size={16} aria-hidden="true" /> Install Lucia
            </button>
          ) : !installed ? (
            <details className="pwa-install-help" data-testid="pwa-install-help">
              <summary>Install Lucia</summary>
              <p>{installInstructions()}</p>
            </details>
          ) : null}
          {installPrompt && (
            <details className="pwa-install-help">
              <summary>Need help?</summary>
              <p>{installInstructions()}</p>
            </details>
          )}
        </section>
      )}
      {hasWaitingUpdate && (
        <section className="pwa-update" role="status" aria-live="polite" data-testid="pwa-update-notice">
          <div>
            <strong>A new version of Lucia is ready.</strong>
            <p>Save or finish your work before refreshing to update the app.</p>
          </div>
          <button className="button button-primary" type="button" onClick={applyUpdate} disabled={updating} data-testid="button-apply-app-update">
            <RefreshCw size={16} aria-hidden="true" /> {updating ? 'Updating…' : 'Refresh to update'}
          </button>
        </section>
      )}
    </aside>
  );
}
