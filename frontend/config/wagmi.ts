import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { bscTestnet } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'AEGIS',
  projectId: '53329360a7a589acc3b8c77ff52d9359',
  chains: [bscTestnet],
  ssr: true,
});