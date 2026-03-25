import * as esbuild from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'

const watch = process.argv.includes('--watch')

/** Recursively copy a directory */
async function copyDir(src: string, dest: string): Promise<void> {
	await fs.mkdir(dest, { recursive: true })
	for (const entry of await fs.readdir(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name)
		const destPath = path.join(dest, entry.name)
		if (entry.isDirectory()) {
			await copyDir(srcPath, destPath)
		} else {
			await fs.copyFile(srcPath, destPath)
		}
	}
}

const buildOptions: esbuild.BuildOptions = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outdir: 'dist',
	target: 'node20',
	sourcemap: true,
	external: ['@mariozechner/*'],
	banner: {
		js: '// pi-fleet extension bundle',
	},
}

async function main() {
	if (watch) {
		const ctx = await esbuild.context(buildOptions)
		await ctx.watch()
		console.log('Watching for changes...')
	} else {
		await esbuild.build(buildOptions)
		await copyDir('templates', 'dist/templates')
		console.log('Build complete.')
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
