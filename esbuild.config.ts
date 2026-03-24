import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

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
		console.log('Build complete.')
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
