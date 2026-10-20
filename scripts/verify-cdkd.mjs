import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, BootstraplessSynthesizer, CfnOutput, Stack } from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnMicrovmImage } from 'aws-cdk-lib/aws-lambda';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = require.resolve('@go-to-k/cdkd/package.json');
const cdkdPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
const cdkdBin = join(dirname(packagePath), cdkdPackage.bin.cdkd);
const workDir = mkdtempSync(join(tmpdir(), 'microvms-cdkd-check-'));

try {
  const app = new App({
    autoSynth: false,
    analyticsReporting: false,
    outdir: join(workDir, 'assembly'),
  });
  const stack = new Stack(app, 'OfflineMicrovmCompatibilityCheck', {
    env: { account: '000000000000', region: 'us-east-1' },
    synthesizer: new BootstraplessSynthesizer(),
  });
  const bucket = new CfnBucket(stack, 'Artifacts', {
    publicAccessBlockConfiguration: {
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    },
  });
  const logs = new CfnLogGroup(stack, 'BuildLogs', { retentionInDays: 7 });
  const buildRole = new CfnRole(stack, 'BuildRole', {
    assumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: ['sts:AssumeRole', 'sts:TagSession'],
      }],
    },
    policies: [{
      policyName: 'ReadImageArtifact',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['s3:GetObject'],
          Resource: `${bucket.attrArn}/offline-only.zip`,
        }],
      },
    }],
  });
  const image = new CfnMicrovmImage(stack, 'Image', {
    name: 'offline-compatibility-check-do-not-deploy',
    description: 'Local schema compatibility probe; no deployable image artifact exists.',
    baseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
    baseImageVersion: 'offline-only',
    buildRoleArn: buildRole.attrArn,
    codeArtifact: { uri: `s3://${bucket.ref}/offline-only.zip` },
    cpuConfigurations: [{ architecture: 'ARM_64' }],
    resources: [{ minimumMemoryInMiB: 2048 }],
    additionalOsCapabilities: [],
    egressNetworkConnectors: [],
    environmentVariables: [],
    hooks: {},
    logging: { cloudWatch: { logGroup: logs.ref, logStream: 'offline-only' } },
  });
  new CfnOutput(stack, 'ImageArn', { value: image.attrImageArn });

  const assembly = app.synth();
  const template = assembly.getStackArtifact(stack.artifactId).template;
  assert.equal(template.Transform, undefined);
  const resourceTypes = [...new Set(Object.values(template.Resources).map(r => r.Type))].sort();
  assert.deepEqual(resourceTypes, [
    'AWS::IAM::Role',
    'AWS::Lambda::MicrovmImage',
    'AWS::Logs::LogGroup',
    'AWS::S3::Bucket',
  ]);

  const emptyConfig = join(workDir, 'empty-aws-config');
  writeFileSync(emptyConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(AWS_|CDK_|CDKD_|NODE_OPTIONS$)/.test(key)));
  const result = spawnSync(process.execPath, [cdkdBin, 'synth', '--app', assembly.directory, '--strict'], {
    cwd: workDir,
    env: {
      ...env,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONFIG_FILE: emptyConfig,
      AWS_SHARED_CREDENTIALS_FILE: emptyConfig,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `cdkd exited with ${result.status}`);
  for (const type of resourceTypes) assert.ok(result.stdout.includes(type), `Missing ${type} in cdkd output`);
  assert.ok(result.stdout.includes('ImageArn'), 'Missing image ARN output');

  const dependencies = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).devDependencies;
  console.log(JSON.stringify({
    result: 'passed',
    cdkdVersion: cdkdPackage.version,
    cdkVersion: dependencies['aws-cdk-lib'],
    resourceTypes,
    checks: ['CDK template generation', 'cdkd synth reading the generated assembly', 'image ARN output'],
    awsDeploymentTested: false,
    note: 'Offline fixture only. Image build, permissions and runtime behavior remain untested.',
  }, null, 2));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
