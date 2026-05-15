"use client";

import * as React from "react";
import { Copy, Link as LinkIcon, Mail, Send, Share2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ShareDialogProps {
  sessionId: string;
  /** Controlled open state. Omit (with onOpenChange) to use built-in trigger button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional override for the share URL origin (defaults to window.location.origin). */
  origin?: string;
  /** Recording title — shown in the dialog header for context. */
  title?: string;
  /** Label of the auto-rendered trigger button when uncontrolled. */
  triggerLabel?: string;
}

export function ShareDialog({
  sessionId,
  open: openProp,
  onOpenChange,
  origin,
  title,
  triggerLabel,
}: ShareDialogProps) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = isControlled ? !!openProp : internalOpen;
  const setOpen = React.useCallback(
    (v: boolean) => {
      if (isControlled) onOpenChange?.(v);
      else setInternalOpen(v);
    },
    [isControlled, onOpenChange]
  );

  const [email, setEmail] = React.useState("");
  const [permission, setPermission] = React.useState("viewer");
  const [note, setNote] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);

  const sendEmail = async () => {
    if (!email.trim()) {
      toast.error("请输入邮箱");
      return;
    }
    setSending(true);
    try {
      const resp = await fetch("/api/share/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, email, permission, note }),
      });
      if (resp.ok) {
        toast.success("分享邀请已发送");
        setOpen(false);
      } else if (resp.status === 404 || resp.status === 501) {
        toast("分享功能即将推出");
      } else {
        toast.error(`发送失败 (${resp.status})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "发送失败";
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  const generateLink = () => {
    const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
    setLink(`${base}/share/preview/${sessionId}`);
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const headerSubtitle = title
    ? `${title} · 选择邮箱邀请或生成可访问的链接`
    : "选择邮箱邀请或生成可访问的链接";

  return (
    <>
      {!isControlled && (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Share2 className="h-4 w-4" />
          <span>{triggerLabel ?? "分享"}</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>分享会议</DialogTitle>
            <DialogDescription>{headerSubtitle}</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="email" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="email">
                <Mail className="mr-1.5 h-4 w-4" />
                邮箱分享
              </TabsTrigger>
              <TabsTrigger value="link">
                <LinkIcon className="mr-1.5 h-4 w-4" />
                链接分享
              </TabsTrigger>
            </TabsList>

            <TabsContent value="email" className="flex flex-col gap-3 pt-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-email">邮箱</Label>
                <Input
                  id="share-email"
                  type="email"
                  value={email}
                  placeholder="name@example.com"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>权限</Label>
                <Select value={permission} onValueChange={setPermission}>
                  <SelectTrigger aria-label="权限">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">观察者（仅查看）</SelectItem>
                    <SelectItem value="commenter">评论者</SelectItem>
                    <SelectItem value="editor">编辑者</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-note">附言</Label>
                <Textarea
                  id="share-note"
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="（可选）"
                />
              </div>
              <DialogFooter>
                <Button onClick={sendEmail} disabled={sending}>
                  <Send className="h-4 w-4" />
                  <span>发送分享邀请</span>
                </Button>
              </DialogFooter>
            </TabsContent>

            <TabsContent value="link" className="flex flex-col gap-3 pt-2">
              {link ? (
                <div className="flex items-center gap-2">
                  <Input readOnly value={link} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={copyLink} aria-label="复制链接">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  生成分享链接后，您可以将其发送给他人。
                </p>
              )}
              <DialogFooter>
                <Button onClick={generateLink}>
                  <LinkIcon className="h-4 w-4" />
                  <span>生成链接</span>
                </Button>
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ShareDialog;
