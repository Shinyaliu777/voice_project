"use client";

import * as React from "react";
import { Download, FileAudio, FileText, FileType } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ExportMenuProps {
  sessionId: string;
  className?: string;
}

export function ExportMenu({ sessionId: _sessionId, className }: ExportMenuProps) {
  const placeholder = () => toast("Coming soon");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={className}>
          <Download className="h-4 w-4" />
          <span>导出</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={placeholder}>
          <FileType className="h-4 w-4" />
          <span>导出为 Word (.docx)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={placeholder}>
          <FileText className="h-4 w-4" />
          <span>导出为 PDF (.pdf)</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={placeholder}>
          <FileAudio className="h-4 w-4" />
          <span>导出音频 (.webm)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ExportMenu;
