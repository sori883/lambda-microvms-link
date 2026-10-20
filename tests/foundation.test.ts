import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { MicrovmFoundationStack } from '../infra/microvm-foundation-stack.ts';

const imageSourcePath = fileURLToPath(new URL('../image/', import.meta.url));
const require = createRequire(import.meta.url);
const cdkdPackagePath = require.resolve('@go-to-k/cdkd/package.json');
const cdkdPackage = JSON.parse(readFileSync(cdkdPackagePath, 'utf8'));
const cdkdBin = join(dirname(cdkdPackagePath), cdkdPackage.bin.cdkd);

function synth(outdir: string, source = imageSourcePath, baseImageVersion?: string) {
  const app = new App({ outdir, autoSynth: false, analyticsReporting: false });
  const stack = new MicrovmFoundationStack(app, 'MicrovmFoundation', {
    imageSourcePath: source,
    baseImageVersion,
  });
  const assembly = app.synth();
  const template = assembly.getStackArtifact(stack.artifactId).template;
  const assets = JSON.parse(readFileSync(join(outdir, 'MicrovmFoundation.assets.json'), 'utf8'));
  return { template, assets };
}

test('the real stack packages only image files and orders scoped build permissions before the image', () => {
  const work = mkdtempSync(join(tmpdir(), 'microvm-foundation-'));
  try {
    const assemblyDir = join(work, 'assembly');
    const { template, assets } = synth(assemblyDir);
    assert.deepEqual(Object.values(template.Resources).map((r: any) => r.Type).sort(), [
      'AWS::IAM::Role', 'AWS::Lambda::MicrovmImage', 'AWS::Logs::LogGroup',
    ]);
    const image = template.Resources.Image;
    const role = template.Resources.BuildRole;
    const logs = template.Resources.BuildLogs;
    assert.equal(image.Properties.BaseImageVersion, undefined);
    assert.equal(image.Properties.AdditionalOsCapabilities, undefined);
    assert.deepEqual(image.DependsOn, ['BuildLogs', 'BuildRole']);
    assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement, [{
      Effect: 'Allow',
      Principal: { Service: 'lambda.amazonaws.com' },
      Action: ['sts:AssumeRole', 'sts:TagSession'],
    }]);
    assert.equal(role.Properties.ManagedPolicyArns, undefined);
    const policies = role.Properties.Policies;
    assert.equal(policies.length, 1);
    assert.equal(policies[0].PolicyDocument.Statement.length, 2);
    const [read, write] = policies[0].PolicyDocument.Statement;
    assert.deepEqual(read.Action, ['s3:GetObject']);
    assert.ok(!JSON.stringify(read.Resource).includes('*'));
    assert.deepEqual(write.Action, ['logs:CreateLogStream', 'logs:PutLogEvents']);
    assert.deepEqual(write.Resource, { 'Fn::GetAtt': ['BuildLogs', 'Arn'] });
    assert.equal(logs.Properties.RetentionInDays, 7);
    assert.equal(logs.DeletionPolicy, 'Retain');
    assert.equal(template.Transform, undefined);

    const zipAssets = Object.values(assets.files).filter((a: any) => a.source.packaging === 'zip') as any[];
    assert.equal(zipAssets.length, 1);
    const zip = zipAssets[0];
    assert.deepEqual(readdirSync(join(assemblyDir, zip.source.path)).sort(), ['Dockerfile', 'desktop.mjs', 'mvm-desktop', 'mvm-sshd', 'server.mjs']);
    const destination: any = Object.values(zip.destinations)[0];
    assert.ok(JSON.stringify(image.Properties.CodeArtifact.Uri).includes(destination.objectKey));
    assert.ok(JSON.stringify(read.Resource).includes(destination.objectKey));
    assert.deepEqual(template.Outputs.ImageArn.Value, { 'Fn::GetAtt': ['Image', 'ImageArn'] });

    const emptyConfig = join(work, 'empty-aws-config');
    writeFileSync(emptyConfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(AWS_|CDK_|CDKD_|NODE_OPTIONS$)/.test(key)));
    const result = spawnSync(process.execPath, [cdkdBin, 'synth', '--app', assemblyDir, '--strict'], {
      cwd: work,
      env: { ...env, AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: emptyConfig, AWS_SHARED_CREDENTIALS_FILE: emptyConfig },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('AWS::Lambda::MicrovmImage'));
    assert.ok(result.stdout.includes('ImageArn'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('image and SSH helper edits change the artifact URI; unrelated files do not, and a base version can be pinned', () => {
  const work = mkdtempSync(join(tmpdir(), 'microvm-asset-update-'));
  try {
    const source = join(work, 'image');
    cpSync(imageSourcePath, source, { recursive: true });
    const initial = synth(join(work, 'initial'), source).template;
    const again = synth(join(work, 'again'), source).template;
    assert.deepEqual(again, initial);
    writeFileSync(join(source, '.env'), 'SECRET=must-not-be-packaged');
    const unrelated = synth(join(work, 'unrelated'), source).template;
    assert.deepEqual(unrelated, initial);
    writeFileSync(join(source, 'mvm-sshd'), readFileSync(join(source, 'mvm-sshd'), 'utf8') + '\n');
    const helperEdited = synth(join(work, 'helper-edited'), source).template;
    assert.notDeepEqual(helperEdited.Resources.Image.Properties.CodeArtifact, initial.Resources.Image.Properties.CodeArtifact);
    assert.notDeepEqual(helperEdited.Resources.BuildRole.Properties.Policies, initial.Resources.BuildRole.Properties.Policies);
    writeFileSync(join(source, 'desktop.mjs'), readFileSync(join(source, 'desktop.mjs'), 'utf8') + '\n');
    const desktopEdited = synth(join(work, 'desktop-edited'), source).template;
    assert.notDeepEqual(desktopEdited.Resources.Image.Properties.CodeArtifact, helperEdited.Resources.Image.Properties.CodeArtifact);
    writeFileSync(join(source, 'server.mjs'), readFileSync(join(source, 'server.mjs'), 'utf8') + '\n');
    const edited = synth(join(work, 'edited'), source, '1.0').template;
    assert.notDeepEqual(edited.Resources.Image.Properties.CodeArtifact, helperEdited.Resources.Image.Properties.CodeArtifact);
    assert.notDeepEqual(edited.Resources.BuildRole.Properties.Policies, helperEdited.Resources.BuildRole.Properties.Policies);
    assert.equal(edited.Resources.Image.Properties.Name, initial.Resources.Image.Properties.Name);
    assert.equal(edited.Resources.Image.Properties.BaseImageVersion, '1.0');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
