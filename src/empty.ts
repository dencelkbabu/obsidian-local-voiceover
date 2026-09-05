const empty = {
	readFile: undefined,
	resolve: (...args: string[]) => args.join("/"),
	join: (...args: string[]) => args.join("/"),
};

export default empty;
export const readFile = undefined;
export const resolve = (...args: string[]) => args.join("/");
export const join = (...args: string[]) => args.join("/");
