import { existsSync, readFileSync } from 'node:fs';

/**
 * Global adjustments to the synthetic population, fitted to real sessions.
 *
 * The archetypes are hand-designed and their scales are guesses: how long
 * a read takes, how far people scroll, how readily they open, how much of
 * a piece they read, how often they press a button. Calibration keeps
 * the archetypes' shape (their differences from each other) and moves the
 * whole population so its per-session metrics sit where real readers'
 * do. Five numbers, one per compared metric, so the fit is identifiable
 * from a few dozen sessions:
 *
 *   dwell       multiplies dwell time                 (dwellMin)
 *   readDepth   multiplies read depth, clamped        (completion)
 *   curiosity   added to the open logit               (opens)
 *   patience    multiplies items looked at            (scrollPast)
 *   social      multiplies save/share/follow chance   (actions)
 *
 * Identity is the simulator as designed.
 */
export interface Calibration {
  dwell: number;
  readDepth: number;
  curiosity: number;
  patience: number;
  social: number;
}

export const IDENTITY: Calibration = { dwell: 1, readDepth: 1, curiosity: 0, patience: 1, social: 1 };

export const CALIBRATION_KEYS = ['dwell', 'readDepth', 'curiosity', 'patience', 'social'] as const;

export function validateCalibration(c: unknown): Calibration {
  if (typeof c !== 'object' || c === null) throw new Error('calibration must be an object');
  const o = c as Record<string, unknown>;
  const out = { ...IDENTITY };
  for (const k of CALIBRATION_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`calibration.${k} must be a finite number`);
    if (k !== 'curiosity' && !(v > 0)) throw new Error(`calibration.${k} must be positive`);
    out[k] = v;
  }
  return out;
}

/** A calibration file as written by `npm run calibrate`: the fitted values plus how they were fitted. */
export interface CalibrationFile {
  calibration: Calibration;
  fittedAt?: string;
  sessions?: number;
  before?: Record<string, number>;
  after?: Record<string, number>;
}

export function loadCalibration(file: string): Calibration {
  if (!existsSync(file)) throw new Error(`no calibration at ${file}; run npm run calibrate first`);
  const json = JSON.parse(readFileSync(file, 'utf8')) as CalibrationFile | Calibration;
  return validateCalibration('calibration' in json ? json.calibration : json);
}

export function describeCalibration(c: Calibration): string {
  return CALIBRATION_KEYS.map((k) => `${k} ${k === 'curiosity' ? (c[k] >= 0 ? '+' : '') + c[k].toFixed(2) : '×' + c[k].toFixed(2)}`).join(', ');
}
