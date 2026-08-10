CREATE TABLE "doubt_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid,
	"reply_id" uuid,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doubt_reports_thread_once" UNIQUE("thread_id","reporter_id"),
	CONSTRAINT "doubt_reports_reply_once" UNIQUE("reply_id","reporter_id")
);
--> statement-breakpoint
ALTER TABLE "doubt_replies" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doubt_replies" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "doubt_replies" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "doubt_threads" ADD COLUMN "image_r2_key" text;--> statement-breakpoint
ALTER TABLE "doubt_threads" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doubt_threads" ADD COLUMN "hidden_by" uuid;--> statement-breakpoint
ALTER TABLE "doubt_threads" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "doubt_reports" ADD CONSTRAINT "doubt_reports_thread_id_doubt_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."doubt_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubt_reports" ADD CONSTRAINT "doubt_reports_reply_id_doubt_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."doubt_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubt_reports" ADD CONSTRAINT "doubt_reports_reporter_id_profiles_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doubt_reports_open_idx" ON "doubt_reports" USING btree ("created_at") WHERE reviewed_at IS NULL;--> statement-breakpoint
ALTER TABLE "doubt_replies" ADD CONSTRAINT "doubt_replies_hidden_by_profiles_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doubt_threads" ADD CONSTRAINT "doubt_threads_hidden_by_profiles_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doubt_replies_thread_idx" ON "doubt_replies" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "doubt_threads_inbox_idx" ON "doubt_threads" USING btree ("course_id","created_at") WHERE NOT is_resolved AND hidden_at IS NULL;