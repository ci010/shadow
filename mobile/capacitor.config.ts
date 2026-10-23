import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.shadow.mobile',
  appName: 'Shadow',
  webDir: '../app/dist-mobile',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
