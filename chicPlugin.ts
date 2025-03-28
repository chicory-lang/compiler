import { plugin } from "bun";
import compile from "./compile";

plugin({
  name: "Chicory",
  async setup(build) {
    build.onLoad({ filter: /\.chic/ }, async (args) => {
      const file = await Bun.file(args.path).text();
      const { code } = compile(file);
      return {
        exports: await import(`data:text/javascript,${encodeURIComponent(code)}`),
        loader: 'object',
      };
    })
  },
});
