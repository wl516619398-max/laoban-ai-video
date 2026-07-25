"""Reserved interface for a future video understanding agent.

This module is intentionally not called by the V0.2 MVP.
"""

from typing import Any


def analyze_video_material(material_id: str) -> dict[str, Any]:
    raise NotImplementedError("视频理解 Agent 尚未接入")

