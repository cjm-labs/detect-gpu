// Data
import pkg from '../package.json';

// Internal
import { BLOCKLISTED_GPU } from './internal/GPUBlocklist';
import { cleanRenderer } from './internal/cleanRenderer';
import { deobfuscateRenderer } from './internal/deobfuscateRenderer';
import { deviceInfo } from './internal/deviceInfo';
import { getLevenshteinDistance } from './internal/getLevenshteinDistance';
import { getGPUVersion } from './internal/getGPUVersion';
import { getWebGLContext } from './internal/getWebGLContext';

// Types
export interface GetGPUTier {
  glContext?: WebGLRenderingContext | WebGL2RenderingContext;
  failIfMajorPerformanceCaveat?: boolean;
  mobileTiers?: number[];
  desktopTiers?: number[];
  override?: {
    renderer?: string;
    isIpad?: boolean;
    isMobile?: boolean;
    screenSize?: { width: number; height: number };
    loadBenchmarks?: (file: string) => Promise<ModelEntry[] | undefined>;
  };
  benchmarksURL?: string;
}

export type TierType =
  | 'IS_SRR'
  | 'WEBGL_UNSUPPORTED'
  | 'BLOCKLISTED'
  | 'FALLBACK'
  | 'BENCHMARK';

export type TierResult = {
  tier: number;
  type: TierType;
  isMobile?: boolean;
  fps?: number;
  gpu?: string;
  device?: string;
};

export type ModelEntryScreen = [number, number, number, string | undefined];

export type ModelEntry = [string, string, 0 | 1, ModelEntryScreen[]];

const debug = false ? console.log : undefined;

const isSSR = typeof window === 'undefined';

const queryCache: { [k: string]: Promise<ModelEntry[] | undefined> } = {};

export const getGPUTier = async ({
  mobileTiers = [0, 15, 30, 60],
  desktopTiers = [0, 15, 30, 60],
  override: {
    renderer,
    isIpad = Boolean(deviceInfo?.isIpad),
    isMobile = Boolean(deviceInfo?.isMobile),
    screenSize = window.screen,
    loadBenchmarks,
  } = {},
  glContext,
  failIfMajorPerformanceCaveat = false,
  benchmarksURL = `https://unpkg.com/detect-gpu@${pkg.version}/dist/benchmarks`,
}: GetGPUTier = {}): Promise<TierResult> => {
  if (isSSR) {
    return {
      tier: 0,
      type: 'IS_SRR',
    };
  }

  const queryBenchmarks = async (
    loadBenchmarks = async (file: string) => {
      try {
        const data: ModelEntry[] = await fetch(
          `${benchmarksURL}/${file}`
        ).then((response) => response.json());

        // Remove version tag
        data.shift();

        return data;
      } catch (err) {
        console.error(err);
        return undefined;
      }
    },

    renderer: string
  ): Promise<[number, number, string, string | undefined] | []> => {
    const types = isMobile
      ? ['adreno', 'apple', 'mali-t', 'mali', 'nvidia', 'powervr']
      : ['intel', 'amd', 'radeon', 'nvidia', 'geforce'];

    let type: string | undefined;

    for (let i = 0; i < types.length; i++) {
      const typesType = types[i];

      if (renderer.indexOf(typesType) > -1) {
        type = typesType;
        break;
      }
    }

    if (!type) {
      return [];
    }

    debug?.('queryBenchmarks - found type:', { type });

    const benchmarkFile = `${isMobile ? 'm' : 'd'}-${type}.json`;

    const benchmark: Promise<ModelEntry[] | undefined> = (queryCache[
      benchmarkFile
    ] = queryCache[benchmarkFile] || loadBenchmarks(benchmarkFile));

    const benchmarks = await benchmark;

    if (!benchmarks) {
      return [];
    }

    const version = getGPUVersion(renderer);

    const isApple = type === 'apple';

    let matched: ModelEntry[] = benchmarks.filter(
      ([, modelVersion]) => modelVersion === version
    );

    debug?.(
      `found ${matched.length} matching entries using version '${version}':`,

      matched.map(([model]) => model)
    );

    // If nothing matched, try comparing model names:
    if (!matched.length) {
      matched = benchmarks.filter(([model]) => model.indexOf(renderer) > -1);

      debug?.(
        `found ${matched.length} matching entries comparing model names`,
        {
          matched,
        }
      );
    }

    const count = matched.length;

    if (count === 0) {
      return [];
    }

    // eslint-disable-next-line prefer-const
    let [gpu, , , fpsesByPixelCount] =
      count > 1
        ? matched
            .map(
              (match) =>
                [match, getLevenshteinDistance(renderer, match[0])] as const
            )
            .sort(([, a], [, b]) => a - b)[0][0]
        : matched[0];

    debug?.(
      `${renderer} matched closest to ${gpu} with the following screen sizes`,
      JSON.stringify(fpsesByPixelCount)
    );

    let minDistance = Number.MAX_VALUE;
    let closest: ModelEntryScreen;
    const { devicePixelRatio } = window;
    const pixelCount =
      screenSize.width *
      devicePixelRatio *
      (screenSize.height * devicePixelRatio);

    // Extra step for apple devices to distinguish between ipad and iphone
    // devices (which often share screen resolutions):
    if (isApple && isMobile) {
      fpsesByPixelCount = fpsesByPixelCount.filter(
        ([, , , device]) =>
          (device?.indexOf(isIpad ? 'ipad' : 'iphone') ?? -1) > -1
      );
    }

    for (let i = 0; i < fpsesByPixelCount.length; i++) {
      const match = fpsesByPixelCount[i];
      const [width, height] = match;
      const entryPixelCount = width * height;
      const distance = Math.abs(pixelCount - entryPixelCount);

      if (distance < minDistance) {
        minDistance = distance;
        closest = match;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [, , fps, device] = closest!;

    return [minDistance, fps, gpu, device];
  };

  const toResult = (
    tier: number,
    type: TierType,
    gpu?: string,
    fps?: number,
    device?: string
  ) => ({
    device,
    fps,
    gpu,
    isMobile,
    tier,
    type,
  });

  let renderers: string[];

  if (!renderer) {
    const gl =
      glContext ||
      getWebGLContext(deviceInfo?.isSafari12, failIfMajorPerformanceCaveat);

    if (!gl) {
      return toResult(0, 'WEBGL_UNSUPPORTED');
    }

    const debugRendererInfo = gl.getExtension('WEBGL_debug_renderer_info');

    if (debugRendererInfo) {
      renderer = gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL);
    }

    if (!renderer) {
      return toResult(1, 'FALLBACK');
    }

    renderer = cleanRenderer(renderer);
    renderers = deobfuscateRenderer(gl, renderer, isMobile);
  } else {
    renderer = cleanRenderer(renderer);
    renderers = [renderer];
  }

  const results = await Promise.all(
    renderers.map(
      (
        renderer: string
      ): Promise<[number, number, string, string | undefined] | []> =>
        queryBenchmarks(loadBenchmarks, renderer)
    )
  );

  const result =
    results.length === 1
      ? results[0]
      : results.sort(
          ([aDis = Number.MAX_VALUE], [bDis = Number.MAX_VALUE]) => aDis - bDis
        )[0];

  if (result.length === 0) {
    return BLOCKLISTED_GPU.filter(
      (blocklistedModel) => (renderer?.indexOf(blocklistedModel) as number) > -1
    )[0]
      ? toResult(0, 'BLOCKLISTED', renderer)
      : toResult(1, 'FALLBACK', renderer);
  }

  const [, fps, model, device] = result;

  if (fps === -1) {
    return toResult(0, 'BLOCKLISTED', model, fps, device);
  }

  const tiers = isMobile ? mobileTiers : desktopTiers;
  let tier = 0;

  for (let i = 0; i < tiers.length; i++) {
    if (fps >= tiers[i]) {
      tier = i;
    }
  }

  return toResult(tier, 'BENCHMARK', model, fps, device);
};
