import type { Device } from '../../gl'
import type { GraphConfigInterface } from '../config'
import type { GraphData } from '../graph-data'
import type { Store } from '../store'
import type { Points } from './points'

/**
 * Base for every render and force module.
 *
 * Each one is handed the same `device`, `config`, `store` and `data` instances,
 * so a change to any of them is visible everywhere on the next frame without
 * being threaded through call arguments. Force modules additionally receive
 * `points`, since every force reads the current position texture and writes
 * into the shared velocity target it owns.
 */
export class CoreModule {
  public readonly device: Device
  public readonly config: GraphConfigInterface
  public readonly store: Store
  public readonly data: GraphData
  public readonly points: Points | undefined

  public constructor (
    device: Device,
    config: GraphConfigInterface,
    store: Store,
    data: GraphData,
    points?: Points
  ) {
    this.device = device
    this.config = config
    this.store = store
    this.data = data
    if (points) this.points = points
  }
}
