import { defineHook } from "@directus/extensions-sdk";
import { TransformationParams, TransformationSet, TransformationFormat, AbstractServiceOptions } from "@directus/types";

type FitMode = "contain" | "cover" | "fill" | "inside" | "outside";

export default defineHook(({ action }, { services, env }) => {
    const { AssetsService, FilesService } = services;

    const envQuality: number = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_QUALITY ?? 50;

    // Width and height are independent.
    //   - Both set:    sharp combines them via `fit` (see envFit below).
    //   - Only one:    sharp auto-scales the other to preserve aspect ratio.
    //   - Both unset:  resize is skipped — only re-encode/compress runs.
    // See https://sharp.pixelplumbing.com/api-resize/
    const envMaxWidth: number | null = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH ?? null;
    const envMaxHeight: number | null = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT ?? null;
    const rawFit: string = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT ?? "inside";
    const envFit: FitMode = isValidFit(rawFit) ? rawFit : "inside";
    const envWithoutEnlargement: boolean = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_WITHOUT_ENLARGEMENT ?? true;

    const envTargetFormat: TransformationFormat = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT ?? "avif";
    const envMaxAttempts: number = env.EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_ATTEMPTS ?? 10;

    function isImage(value: string): value is "image" {
        return value === "image";
    }

    function isValidTransformationFormat(value: string): value is TransformationFormat {
        return ["jpg", "jpeg", "png", "webp", "tiff", "avif"].includes(value);
    }

    function isValidFit(value: string): value is FitMode {
        return ["contain", "cover", "fill", "inside", "outside"].includes(value);
    }

    // Alternative to "path.parse(str).name"
    // (because "path" can't be imported in a "sandboxed" env)
    function getFileName(filePath: string) {
        const fileName = filePath.split("/").pop()!.split("."); // i-am/a-file.example.jpeg -> ["a-file", "example", "jpeg"]
        return fileName.length > 1 ? fileName.slice(0, -1).join(".") : fileName[0];
    }

    // Storage adapters may not have flushed the upload yet when this hook fires;
    // retry getAsset with linear backoff until the bytes are readable.
    async function waitForAsset(assetsService: any, key: string, transformationSet: TransformationSet, maxAttempts = envMaxAttempts, delayMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                return await assetsService.getAsset(key, transformationSet);
            } catch (err) {
                if (i === maxAttempts - 1) throw err;
                await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
            }
        }
    }

    action("files.upload", async ({ payload, key }, context) => {
        const [fileType, fileSubType]: [string, string] = payload.type?.split("/");

        if (!isImage(fileType)) return;
        if (!isValidTransformationFormat(fileSubType)) return;
        if (!isValidTransformationFormat(envTargetFormat)) return;

        const transformationParams: TransformationParams = {
            format: envTargetFormat,
            quality: envQuality,
            width: envMaxWidth,
            height: envMaxHeight,
            fit: envFit,
            withoutEnlargement: envWithoutEnlargement,
        };

        const transformationSet: TransformationSet = {
            transformationParams,
        };

        const serviceOptions: AbstractServiceOptions = {
            accountability: null, // this hook runs as an internal process
            knex: context.database,
            schema: context.schema!,
        };

        const assetsService = new AssetsService(serviceOptions);
        const filesService = new FilesService(serviceOptions);

        const { stream, stat } = await waitForAsset(assetsService, key, transformationSet);

        // Stop if new file would be bigger (useless process)
        if (stat.size >= payload.filesize) return;

        // Modify payload to renamed file
        if (fileSubType !== envTargetFormat) {
            payload.type = payload.type.replace(fileSubType, envTargetFormat);
            payload.filename_download = getFileName(payload.filename_download) + `.${envTargetFormat}`;
            payload.filename_disk = getFileName(payload.filename_disk) + `.${envTargetFormat}`;
        }

        // Drop stale dimensions so FilesService re-reads them from the new stream.
        delete payload.height;
        delete payload.width;

        // Finally upload processed and optimized file
        // emitEvents: false — without it, this write would re-trigger files.upload and recurse indefinitely.
        await filesService.uploadOne(
            stream,
            {
                ...payload,
            },
            key,
            { emitEvents: false },
        );
    });
});
