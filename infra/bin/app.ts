import * as cdk from 'aws-cdk-lib'
import { WhiteboardSiteStack } from '../lib/whiteboard-site-stack'

const app = new cdk.App()

new WhiteboardSiteStack(app, 'WhiteboardSiteStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  githubRepo: app.node.tryGetContext('githubRepo') ?? 'chathurajkonara/black-white-board',
  githubBranch: app.node.tryGetContext('githubBranch') ?? 'master',
  budgetEmail: app.node.tryGetContext('budgetEmail'),
})
