/**
 * A stylesheet imported as text (minified by the build, as is by the tests).
 */
declare module "*.css?raw" {
	const css: string;
	export default css;
}
