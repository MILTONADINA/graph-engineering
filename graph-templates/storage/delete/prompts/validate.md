exports [uploadFileToS3, deleteFile] both present on the same class instance → `npm run build`. If only `uploadFileToS3` is exported, the `modify` step didn't apply.
