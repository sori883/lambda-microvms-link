import { App } from 'aws-cdk-lib';
import { MicrovmFoundationStack } from './microvm-foundation-stack.ts';

const app = new App({ analyticsReporting: false, outdir: process.env.CDK_OUTDIR ?? 'cdk.out' });
const baseImageVersion: unknown = app.node.tryGetContext('baseImageVersion');
if (baseImageVersion !== undefined &&
    (typeof baseImageVersion !== 'string' || baseImageVersion.trim() === '')) {
  throw new Error('baseImageVersion must be a non-empty string when provided.');
}

new MicrovmFoundationStack(app, 'MicrovmFoundation', { baseImageVersion });
app.synth();
