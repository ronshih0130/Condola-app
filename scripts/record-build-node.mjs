import { statSync, writeFileSync } from 'node:fs';

const dir = '.open-next';
const stamp = `${dir}/build-node-version.txt`;

try {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${dir} is missing or is not a directory; the build must produce it`);
    }
    writeFileSync(stamp, process.version + '\n');
} catch (error) {
    console.error(`cannot record build node: ${error.message}`);
    process.exit(1);
}

console.log(`build node: ${process.version} -> ${stamp}`);
