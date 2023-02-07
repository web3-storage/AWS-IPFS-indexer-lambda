'use strict'

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler')
const { Agent } = require('https')
const sleep = require('util').promisify(setTimeout)

const config = require('../config')
const { CarIterator } = require('./iterator')
const { serializeError } = require('./logging')
const telemetry = require('./telemetry')

const s3Clients = {}

async function openS3Stream({ bucketRegion, url, logger, bucket, key, retries = config.s3MaxRetries, retryDelay = config.s3RetryDelay }) {
  /** @type {import('@aws-sdk/client-s3').GetObjectCommandOutput} */
  let s3Request

  if (!s3Clients[bucketRegion]) {
    logger.info("Connectiong to S3 at endpoint '%s' in region '%s'", config.s3EndpointUrl, bucketRegion)
    const s3ClientConfig = {
      region: bucketRegion,
      requestHandler: new NodeHttpHandler({
        httpsAgent: new Agent({ keepAlive: true, keepAliveMsecs: 60000 })
      })
    }
    // support for non-standard or local S3 stacks
    if (config.s3EndpointUrl) {
      s3ClientConfig.endpoint = config.s3EndpointUrl
      s3ClientConfig.s3ForcePathStyle = true
      s3ClientConfig.disableHostPrefix = true
    }

    s3Clients[bucketRegion] = new S3Client(s3ClientConfig)
  }
  const s3Client = s3Clients[bucketRegion]
  telemetry.increaseCount('s3-fetchs')

  let attempts = 0
  let error
  do {
    error = null
    try {
      // this imports just the getObject operation from S3
      s3Request = await telemetry.trackDuration('s3-fetchs', s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key })))
      break
    } catch (err) {
      if (err.code === 'NoSuchKey') {
        // not found
        logger.error({ error: serializeError(err) }, `Cannot open file S3 URL ${url}, does not exists`)
        error = err
        break
      }
      logger.debug(`S3 Error, URL: ${url} Error: "${err.message}" attempt ${attempts + 1} / ${retries}`)
      error = err
    }
    await sleep(retryDelay)
  } while (++attempts < retries)

  if (error) {
    if (attempts === retries) {
      logger.error({ error: serializeError(error) }, `Cannot open file S3 URL ${url} after ${attempts} attempts`)
    }
    throw error
  }

  const stats = {
    lastModified: s3Request.LastModified?.getTime(),
    contentLength: s3Request.ContentLength
  }

  // Start parsing as CAR file
  try {
    const indexer = await CarIterator.fromReader(s3Request.Body, s3Request.ContentLength)
    return { indexer, stats }
  } catch (e) {
    logger.error({ error: serializeError(e) }, `Cannot parse file ${url} as CAR`)
    throw e
  }
}

module.exports = {
  openS3Stream
}
