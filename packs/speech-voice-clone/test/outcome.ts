export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("expected a rejection, but the promise resolved");
		},
		(caught: unknown) => caught,
	);
}

export async function failureOf(attempt: () => Promise<unknown>): Promise<Error> {
	const caught = await rejection(Promise.resolve().then(attempt));
	if (!(caught instanceof Error)) throw new Error("expected the rejection to be an Error");
	return caught;
}
