---
name: aws-serverless
description: "Specialized skill for building production-ready serverless applications on AWS. Covers Lambda functions, API Gateway, DynamoDB, SQS/SNS event-driven patterns, SAM/CDK deployment, and cold start optimization."
source: vibeship-spawner-skills (Apache 2.0)
---

# AWS Serverless

## Patterns

### Lambda Handler Pattern

Proper Lambda function structure with error handling

**When to use**: ['Any Lambda function implementation', 'API handlers, event processors, scheduled tasks']

```javascript
// Node.js Lambda Handler
// handler.js

// Initialize outside handler (reused across invocations)
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Handler function
// Use async handlers: nodejs24.x removed callback handlers and context.callbackWaitsForEmptyEventLoop
exports.handler = async (event, context) => {
  try {
    // Parse input based on event source
    const body = typeof event.body === 'string'
      ? JSON.parse(event.body)
      : event.body;

    // Business logic
    const result = await processRequest(body);

    // Return API Gateway compatible response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // One known origin, from configuration. '*' lets any site read the response.
        'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN
      },
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('Error:', JSON.stringify({
      error: error.message,
      stack: error.stack,
      requestId: context.awsRequestId
    }));

    return {
      statusCode: error.statusCode || 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The detail stays in the log above. A 5xx message can carry table names, ARNs or SQL.
        error: error.statusCode && error.statusCode < 500 ? error.message : 'Internal server error'
      })
    };
  }
};

async function processRequest(data) {
  // Your business logic here
  const result = await docClient.send(new GetCommand({
    TableName: process.env.TABLE_NAME,
    Key: { id: data.id }
  }));
  return result.Item;
}
```

### API Gateway Integration Pattern

REST API and HTTP API integration with Lambda

**When to use**: ['Building REST APIs backed by Lambda', 'Need HTTP endpoints for functions']

```yaml
# template.yaml (SAM)
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31

Globals:
  Function:
    Runtime: nodejs24.x
    Architectures: [arm64]  # Graviton: lower price per ms; use x86_64 only for a native dependency without an arm64 build
    Timeout: 30
    MemorySize: 256
    Environment:
      Variables:
        TABLE_NAME: !Ref ItemsTable

Resources:
  # HTTP API (recommended for simple use cases)
  HttpApi:
    Type: AWS::Serverless::HttpApi
    Properties:
      StageName: prod
      CorsConfiguration:
        AllowOrigins:
          - "https://app.example.com"  # the origins that call this API, never "*" with credentials
        AllowMethods:
          - GET
          - POST
          - DELETE
        AllowHeaders:
          - content-type
          - authorization

  # Lambda Functions
  GetItemFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/handlers/get.handler
      Events:
        GetItem:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /items/{id}
            Method: GET
      Policies:
        - DynamoDBReadPolicy:
            TableName: !Ref ItemsTable

  CreateItemFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/handlers/create.handler
      Events:
        CreateItem:
          Type: HttpApi
          Properties:
            ApiId: !Ref HttpApi
            Path: /items
            Method: POST
      Policies:
        - DynamoDBCrudPolicy:
            TableName: !Ref ItemsTable

  # DynamoDB Table
  ItemsTable:
    Type: AWS::DynamoDB::Table
    Properties:
      AttributeDefinitions:
        - AttributeName: id
          AttributeType: S
      KeySchema:
        - AttributeName: id
          KeyType: HASH
      BillingMode: PAY_PER_REQUEST

Outputs:
  ApiUrl:
    Value: !Sub "https://${HttpApi}.execute-api.${AWS::Region}.amazonaws.com/prod"
```

### Event-Driven SQS Pattern

Lambda triggered by SQS for reliable async processing

**When to use**: ['Decoupled, asynchronous processing', 'Need retry logic and DLQ', 'Processing messages in batches']

```yaml
# template.yaml
Resources:
  ProcessorFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: src/handlers/processor.handler
      Events:
        SQSEvent:
          Type: SQS
          Properties:
            Queue: !GetAtt ProcessingQueue.Arn
            BatchSize: 10
            FunctionResponseTypes:
              - ReportBatchItemFailures  # Partial batch failure handling

  ProcessingQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout: 180  # 6x Lambda timeout
      RedrivePolicy:
        deadLetterTargetArn: !GetAtt DeadLetterQueue.Arn
        maxReceiveCount: 3

  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      MessageRetentionPeriod: 1209600  # 14 days
```

```javascript
// src/handlers/processor.js
exports.handler = async (event) => {
  const batchItemFailures = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);
      await processMessage(body);
    } catch (error) {
      console.error(`Failed to process message ${record.messageId}:`, error);
      // Report this item as failed (will be retried)
      batchItemFailures.push({
        itemIdentifier: record.messageId
      });
    }
  }

  // Return failed items for retry
  return { batchItemFailures };
};

async function processMessage(message) {
  // Your processing logic
  console.log('Processing:', message);

  // Simulate work
  await saveToDatabase(message);
}
```

```python
# Python version
import json
import logging

logger = logging.getLogger()

def handler(event, context):
    batch_item_failures = []

    for record in event['Records']:
        try:
            body = json.loads(record['body'])
            process_message(body)
        except Exception as e:
            logger.error(f"Failed to process {record['messageId']}: {e}")
            batch_item_failures.append({
                'itemIdentifier': record['messageId']
            })

    return {'batchItemFailures': batch_item_failures}
```

## Anti-Patterns

### ❌ Monolithic Lambda

**Why bad**: Large deployment packages cause slow cold starts.
Hard to scale individual operations.
Updates affect entire system.

### ❌ Large Dependencies

**Why bad**: Increases deployment package size.
Slows down cold starts significantly.
Most of SDK/library may be unused.

### ❌ Synchronous Calls in VPC

**Why bad**: VPC-attached Lambdas have ENI setup overhead.
Blocking DNS lookups or connections worsen cold starts.

## ⚠️ Sharp Edges

| Issue | Severity | Solution |
|-------|----------|----------|
| Slow cold starts | high | Measure the INIT phase (CloudWatch `Init Duration`); trim dependencies; initialize clients outside the handler |
| Function times out | high | Set the timeout from measured p99 duration; keep SQS visibility timeout at least 6x the function timeout |
| CPU-bound work is slow | high | Increase memory allocation (CPU scales with memory) |
| Cannot reach the internet/AWS APIs from a VPC | medium | Verify VPC configuration: NAT gateway or VPC endpoints for the services you call |
| Callback-style handler fails on nodejs24.x | medium | Use async handlers; callback handlers and `context.callbackWaitsForEmptyEventLoop` were removed |
| Large file uploads through API Gateway fail | medium | Upload directly to S3 with presigned URLs instead of through the function |
| S3 trigger causes recursive invocations | high | Use different buckets/prefixes for input and output |
