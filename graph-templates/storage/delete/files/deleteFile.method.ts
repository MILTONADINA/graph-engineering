
  async deleteFile(key: string): Promise<void> {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: key }));
    } catch (error) {
      console.error('Error deleting file from object storage:', error);
      throw new APIError('Failed to delete file', HttpStatusCodes.BAD_GATEWAY);
    }
  }
