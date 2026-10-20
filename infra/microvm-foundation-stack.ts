import { fileURLToPath } from 'node:url';
import { CfnOutput, CfnResource, Fn, IgnoreMode, RemovalPolicy, Stack, Validations, type StackProps } from 'aws-cdk-lib';
import { CfnRole } from 'aws-cdk-lib/aws-iam';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

interface MicrovmFoundationStackProps extends StackProps {
  baseImageVersion?: string;
  imageSourcePath?: string;
}

export class MicrovmFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: MicrovmFoundationStackProps = {}) {
    super(scope, id, props);

    const imageName = 'lambda-microvms-link-dev';
    const source = new Asset(this, 'ImageSource', {
      path: props.imageSourcePath ?? fileURLToPath(new URL('../image/', import.meta.url)),
      exclude: ['**', '!Dockerfile', '!server.mjs', '!mvm-sshd', '!mvm-desktop', '!desktop.mjs'],
      ignoreMode: IgnoreMode.GIT,
    });
    const logs = new CfnLogGroup(this, 'BuildLogs', {
      logGroupName: `/aws/lambda-microvms/${imageName}`,
      retentionInDays: 7,
    });
    logs.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const buildRole = new CfnRole(this, 'BuildRole', {
      description: 'Build the lambda-microvms-link development image',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { Service: 'lambda.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
        }],
      },
      policies: [{
        policyName: 'BuildImage',
        policyDocument: {
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: source.bucket.arnForObjects(source.s3ObjectKey),
          }, {
            Effect: 'Allow',
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: logs.attrArn,
          }],
        },
      }],
    });

    const image = new CfnResource(this, 'Image', {
      type: 'AWS::Lambda::MicrovmImage',
      properties: {
        Name: imageName,
        Description: 'SSH and browser desktop image for the CLI development environment',
        BaseImageArn: Fn.sub('arn:${AWS::Partition}:lambda:${AWS::Region}:aws:microvm-image:al2023-1'),
        ...(props.baseImageVersion === undefined ? {} : { BaseImageVersion: props.baseImageVersion }),
        BuildRoleArn: buildRole.attrArn,
        CodeArtifact: { Uri: source.s3ObjectUrl },
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Resources: [{ MinimumMemoryInMiB: 2048 }],
        Hooks: {
          Port: 8080,
          MicrovmImageHooks: {
            Ready: 'ENABLED',
            ReadyTimeoutInSeconds: 60,
            Validate: 'ENABLED',
            ValidateTimeoutInSeconds: 60,
          },
        },
        Logging: { CloudWatch: { LogGroup: logs.ref } },
      },
    });
    Validations.of(image).acknowledge({
      id: 'CloudFormation-Validate::F3003',
      reason: 'cdkd calls CreateMicrovmImage directly. Its API allows omitting BaseImageVersion, AdditionalOsCapabilities, EgressNetworkConnectors and EnvironmentVariables; CDK 2.273 marks these required. See decisions/microvm-foundation in .space/babel.',
    });
    image.addResourceDependency(buildRole);
    image.addResourceDependency(logs);

    new CfnOutput(this, 'ImageArn', { value: image.getAtt('ImageArn').toString() });
    new CfnOutput(this, 'BuildLogGroupName', { value: logs.ref });
  }
}
