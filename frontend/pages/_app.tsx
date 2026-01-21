import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect, useState, createContext } from 'react';
import { ethers } from 'ethers';
import '../styles/globals.css';

type WalletContextType = {
  address?: string;
  provider?: ethers.BrowserProvider;
  connect: () => Promise<void>;
  disconnect: () => void;
};

export const WalletContext = createContext<WalletContextType>({
  address: undefined,
  provider: undefined,
  connect: async () => {},
  disconnect: () => {},
});

function App({ Component, pageProps }: AppProps) {
  const [dark, setDark] = useState(false);
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<ethers.BrowserProvider | undefined>(undefined);

  useEffect(() => {
    // Load persisted theme
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('bw:theme') : null;
      if (saved === 'dark') {
        document.documentElement.classList.add('dark');
        setDark(true);
      } else {
        document.documentElement.classList.remove('dark');
      }
    } catch (e) {
      // ignore
    }

    // Auto-connect if previously connected
    try {
      const prev = localStorage.getItem('bw:connected');
      if (prev === '1') {
        connectWallet().catch(() => {});
      }
    } catch (e) {
      // ignore
    }

    // Setup wallet event listeners if provider exists
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      const eth = (window as any).ethereum;
      eth.on?.('accountsChanged', (accounts: string[]) => {
        if (accounts && accounts.length > 0) {
          try {
            setAddress(ethers.getAddress(accounts[0]));
          } catch {
            setAddress(accounts[0]);
          }
        } else {
          setAddress(undefined);
          try {
            localStorage.removeItem('bw:connected');
          } catch {}
        }
      });
      eth.on?.('chainChanged', () => {
        // simplest behavior: reload to reset provider state
        window.location.reload();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectWallet = async () => {
    if (typeof window === 'undefined' || !(window as any).ethereum) {
      alert('No Ethereum provider found. Install MetaMask or a Cronos-compatible wallet.');
      return;
    }
    try {
      const winEth = (window as any).ethereum;
      const accounts: string[] = await winEth.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) return;
      const acct = accounts[0];
      // ethers v6 BrowserProvider wrapper for window.ethereum
      const bp = new ethers.BrowserProvider(winEth);
      setProvider(bp);
      try {
        setAddress(ethers.getAddress(acct));
      } catch {
        setAddress(acct);
      }
      try {
        localStorage.setItem('bw:connected', '1');
      } catch {}
    } catch (err) {
      console.error('connectWallet error', err);
    }
  };

  const disconnect = () => {
    setAddress(undefined);
    setProvider(undefined);
    try {
      localStorage.removeItem('bw:connected');
    } catch {}
  };

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    if (next) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    try {
      localStorage.setItem('bw:theme', next ? 'dark' : 'light');
    } catch {}
  };

  return (
    <WalletContext.Provider value={{ address, provider, connect: connectWallet, disconnect }}>
      <Head>
        <title>BlockWage — Payroll on Cronos</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 transition-colors">
        <header className="border-b border-gray-200 dark:border-gray-800">
          <div className="container mx-auto flex items-center justify-between py-4 px-4">
            <div className="flex items-center space-x-3">
              <div className="bg-primary-500 text-white rounded-xl px-3 py-2 font-semibold">BlockWage</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Cronos x402 Payroll</div>
            </div>

            <div className="flex items-center space-x-3">
              <button
                onClick={toggleTheme}
                aria-label="Toggle theme"
                className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {dark ? '🌙 Dark' : '☀️ Light'}
              </button>

              {address ? (
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-mono">
                    {address.slice(0, 6)}...{address.slice(-4)}
                  </span>
                  <button onClick={disconnect} className="px-3 py-1 bg-red-500 text-white rounded-md text-sm">
                    Disconnect
                  </button>
                </div>
              ) : (
                <button onClick={connectWallet} className="px-4 py-2 bg-primary-500 text-white rounded-md">
                  Connect Wallet
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="container mx-auto p-6">
          <Component {...pageProps} />
        </main>

        <footer className="border-t border-gray-200 dark:border-gray-800 mt-8">
          <div className="container mx-auto py-6 text-sm text-gray-500 dark:text-gray-400">
            © {new Date().getFullYear()} BlockWage — Built for Cronos x402 automated payroll
          </div>
        </footer>
      </div>

      <style jsx global>{`
        :root {
          --bg: #ffffff;
          --muted: #6b7280;
        }
        .dark {
          --bg: #0f1724;
        }
        html,
        body,
        #__next {
          height: 100%;
        }
        body {
          margin: 0;
          font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
          background: var(--bg);
        }

        /* Minimal container class for pages without Tailwind built (fallback) */
        .container {
          max-width: 1100px;
          margin-left: auto;
          margin-right: auto;
          padding-left: 1rem;
          padding-right: 1rem;
        }
      `}</style>
    </WalletContext.Provider>
  );
}

export default App;
