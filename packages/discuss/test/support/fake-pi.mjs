import * as fs from "node:fs";

const argv = process.argv.slice(2);
fs.writeFileSync(process.env.DISCUSS_TEST_CAPTURE, JSON.stringify({
	argv,
	transcript: fs.readFileSync(process.env.DISCUSS_TEST_TRANSCRIPT, "utf8"),
}));

if (process.env.DISCUSS_TEST_FAIL === "1") {
	process.stderr.write("fake failure");
	process.exitCode = 7;
} else {
	console.log(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "My findings are in this discussion reply." }],
			usage: { totalTokens: 1 },
		},
	}));
}
