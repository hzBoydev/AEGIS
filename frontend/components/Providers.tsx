'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider } from 'wagmi';
import { config } from '@/config/wagmi';
import '@rainbow-me/rainbowkit/styles.css';

const queryClient = new QueryClient();

const aegisTheme = lightTheme({
  accentColor: '#8b7355',
  accentColorForeground: '#ffffff',
  borderRadius: 'medium',
  fontStack: 'system',
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={aegisTheme}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
