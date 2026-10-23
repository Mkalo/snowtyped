import manifest from '../../package.json' with { type: 'json' };

export interface Release {
  readonly version: string;
  readonly channel: string;
  readonly stable: boolean;
}

export function describeRelease(version: string): Release {
  const channel = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1];
  return channel
    ? { version, channel, stable: false }
    : { version, channel: 'stable', stable: true };
}

export const release = describeRelease(manifest.version);
